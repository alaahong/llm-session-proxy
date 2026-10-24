/**
 * cli.js 的分支补测。
 *
 * cli.test.mjs 覆盖的是「能走通的路」：起服务、印横幅、收信号。
 * 这里补的是夹在中间的分支，以及**进程级**的那几件事：
 *
 *   - `--protocol` / `--no-protocol` 两个命令行开关（parseArgv 的 case 分支）
 *   - printBanner 里 base URL 的三种形态（带 basePath / 有改写 / 原样）
 *   - installProcessGuards：stderr 写不进去、短时间内反复出错
 *   - runCli 主流程：起代理 → 印横幅 → 收到 SIGINT 优雅关闭
 *   - runCli 端口被占用时给出可读错误
 *
 * 手段说明：runCli 内部会 `process.exit()`、会往 process 上挂信号与兜底处理器，
 * 所以这里把 `process.exit` 和 `process.on` 临时换成「记账版」，用完逐个摘掉——
 * 否则它们会漏到同进程的其它用例里。
 *
 * **一个踩过的坑（值得留字）**：`shutdown()` 是异步的，而 `process.on('SIGINT')`
 * 挂的是 `() => void shutdown('SIGINT')`——`void` 把 promise 丢掉了。
 * 所以「触发信号」和「关闭真正做完」是两件事：发完信号就还原 `process.exit` 的话，
 * 随后跑到的 `process.exit(0)` 会**真的把测试子进程终结**，node --test 只能把
 * 整个文件报成一个 subtest，逐个用例的成败全部看不到了。
 * 对策：让 `process.exit` 的桩在触发时兑现一个 promise，测试 `await` 它之后再还原。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildConfig } from '../src/config.js';
import { installProcessGuards, parseArgv, printBanner, runCli } from '../src/cli.js';
import { setLang } from '../src/messages.js';

test('parseArgv 识别 --protocol 与 --no-protocol', () => {
  const forced = parseArgv(['--protocol', 'messages']);
  assert.equal(forced.flags.protocol.forced, 'messages', '--protocol 应当强制目标协议');
  assert.equal(forced.flags.protocol.enabled, undefined, '只给 forced，不该顺手改 enabled');

  const off = parseArgv(['--no-protocol']);
  assert.equal(off.flags.protocol.enabled, false, '--no-protocol 应当关掉互转层');
  assert.equal(off.flags.protocol.forced, undefined);

  const inline = parseArgv(['--protocol=responses']);
  assert.equal(inline.flags.protocol.forced, 'responses', '等号写法同样要认');
});

test('printBanner 的 base URL 三态：带前缀 / 有改写 / 原样', () => {
  const lines = [];
  const logger = { info: (...args) => lines.push(args.join(' ')) };
  const url = 'http://127.0.0.1:9355';
  setLang('en');
  try {
    // 注意：分支看的是 config.upstream.basePath，不是 proxy.upstream 的——
    // proxy.upstream 只参与「upstream」那一行的回显。
    printBanner(
      logger,
      buildConfig({ env: {}, flags: { upstream: { basePath: '/zen/go/v1' } } }),
      { upstream: { protocol: 'https', hostHeader: 'opencode.ai', basePath: '/zen/go/v1' } },
      url,
    );
    const withBasePath = lines.join('\n');
    assert.ok(withBasePath.includes('/zen/go/v1'), `带了 basePath 就应当给出带前缀的那个地址:\n${withBasePath}`);
    assert.match(withBasePath, /is appended automatically/i, '要说明前缀是自动补的');
    assert.match(withBasePath, /other paths/i, '还应当提示「换成别的路径」该怎么填');

    lines.length = 0;
    printBanner(
      logger,
      buildConfig({ env: {}, flags: { request: { pathRewrite: [{ pattern: '^/v1/', replacement: '/zen/go/v1/' }] } } }),
      { upstream: { protocol: 'https', hostHeader: 'opencode.ai', basePath: '' } },
      url,
    );
    assert.match(lines.join('\n'), /rewritten/i, '没有 basePath 但有改写规则时应当说明路径被改写');

    lines.length = 0;
    printBanner(
      logger,
      buildConfig({ env: {}, flags: {} }),
      { upstream: { protocol: 'https', hostHeader: 'opencode.ai', basePath: '' } },
      url,
    );
    assert.match(lines.join('\n'), /as-is/i, '两者都没有时就该说按上游路径原样拼接');
  } finally {
    setLang('en');
  }
});

test('installProcessGuards：stderr 写不进去也不影响记名与继续运行', () => {
  const logs = { error: [] };
  const logger = { error: (...args) => logs.error.push(args.join(' ')) };
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => {
    throw new Error('stderr is gone');
  };

  let handler;
  const originalOn = process.on.bind(process);
  process.on = (event, listener) => {
    if (event === 'uncaughtException') handler = listener;
    return originalOn(event, listener);
  };

  try {
    installProcessGuards(logger);
    // 直接调用捕获到的处理器，不真的往进程上抛。
    // 注意：stderr 桩必须此刻还在位——早前一版把还原写进了 finally，
    // 结果 handler 跑到时桩已经没了，catch 分支从未被真正执行过。
    handler(new Error('boom'));
  } finally {
    process.on = originalOn;
    process.stderr.write = originalWrite;
  }
  assert.equal(logs.error.length, 1, 'stderr 写失败不该影响日志记名');
  assert.match(logs.error[0], /uncaughtException/);
  assert.ok(process.removeListener('uncaughtException', handler), '用完要把处理器摘掉');
});

test('installProcessGuards：短时间内反复出错才退出，单次错误放行', () => {
  const logs = { error: [] };
  const logger = { error: (...args) => logs.error.push(args.join(' ')) };
  const exits = [];
  const originalExit = process.exit;
  process.exit = (code) => exits.push(code);

  let handler;
  const originalOn = process.on.bind(process);
  process.on = (event, listener) => {
    if (event === 'uncaughtException') handler = listener;
    return originalOn(event, listener);
  };

  try {
    installProcessGuards(logger);
  } finally {
    process.on = originalOn;
  }

  try {
    for (let i = 0; i < 21; i += 1) handler(new Error(`boom-${i}`));
  } finally {
    process.exit = originalExit;
    process.removeListener('uncaughtException', handler);
  }

  assert.equal(exits.length, 1, '超过 60 秒 20 次的阈值就应当主动退出');
  assert.equal(exits[0], 1);
  assert.ok(
    logs.error.some((line) => /occurrences within|persistent failure/i.test(line)),
    `退出前要说明原因，实际：${JSON.stringify(logs.error)}`,
  );
});

/** runCli 会往 process 上挂的这四类处理器，测试结束后要逐个摘掉。 */
const INSTRUMENTED_EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM'];

/**
 * 把 runCli 的进程级副作用换成记账版。
 *
 * `exited` 在 `process.exit` 被调用时兑现——`shutdown()` 的最后一句就是它，
 * 所以 `await scope.exited` 等于「关闭真的做完了」，之后还原 `process.exit` 才安全。
 */
function instrumentProcess() {
  const registered = [];
  const stderrLines = [];
  let settleExited;
  const exited = new Promise((resolve) => {
    settleExited = resolve;
  });

  const originalOn = process.on.bind(process);
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.on = (event, listener) => {
    registered.push([event, listener]);
    return originalOn(event, listener);
  };
  process.exit = (code) => settleExited(code);
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(String(chunk));
    return originalStderrWrite(chunk, ...rest);
  };

  return {
    registered,
    stderrLines,
    exited,
    restore() {
      process.on = originalOn;
      process.exit = originalExit;
      process.stderr.write = originalStderrWrite;
      for (const [event, listener] of registered) {
        if (!INSTRUMENTED_EVENTS.includes(event)) continue;
        // 只摘自己挂上去的那个：node --test 自己也有 uncaughtException 处理器，不能动
        if (process.listeners(event).includes(listener)) process.removeListener(event, listener);
      }
    },
    /** 触发 runCli 挂上的信号处理器（返回它自己，通常是个被 void 掉的 promise）。 */
    fire(event) {
      const hit = registered.find(([name]) => name === event);
      assert.ok(hit, `runCli 应当注册了 ${event} 处理`);
      return hit[1](event);
    },
  };
}

/**
 * 固定语言与家目录，避免受宿主环境的 PROXY_LANG / 真实 ~/.lsp 影响。
 *
 * 还原时不能直接 `process.env.X = saved.X`：原本没设置时 saved.X 是 undefined，
 * 赋回去会被字符串化成字面量 "undefined"，**污染后续 spawn 出去的子进程**
 * （子进程继承环境，于是报 "Unsupported lang: undefined"）。
 * 按文件隔离跑测试时永远看不到这个坑，只有单进程串跑才会暴露——所以必须 delete。
 */
function isolateEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-branches-'));
  const saved = { LSP_HOME: process.env.LSP_HOME, PROXY_LANG: process.env.PROXY_LANG };
  process.env.LSP_HOME = home;
  process.env.PROXY_LANG = 'en';
  const restoreEnv = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  return {
    home,
    logFile: path.join(home, 'logs', 'llm-session-proxy.log'),
    restore() {
      restoreEnv('LSP_HOME', saved.LSP_HOME);
      restoreEnv('PROXY_LANG', saved.PROXY_LANG);
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('runCli 主流程：起代理、印横幅、收到信号后优雅关闭', async () => {
  const env = isolateEnv();
  const scope = instrumentProcess();
  const savedExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    // 端口 0 = 让系统分配；--host 0.0.0.0 用来走「横幅回显 127.0.0.1」那条分支
    await runCli(['--port', '0', '--host', '0.0.0.0', '-u', 'http://127.0.0.1:1']);

    const text = scope.stderrLines.join('');
    assert.match(text, /started/i, '横幅应当说明已启动');
    assert.match(text, /listening/i, '横幅应当给出监听地址');
    assert.match(text, /http:\/\/127\.0\.0\.1:\d+/, '绑了 0.0.0.0 时横幅要回显 127.0.0.1');
    assert.ok(!/0\.0\.0\.0/.test(text), '横幅里不该出现 0.0.0.0');
    assert.equal(process.exitCode, 0, '正常启动不置退出码');

    // 日志默认落盘，且路径就在 LSP_HOME 下
    assert.ok(fs.existsSync(env.logFile), `日志应当写到 ${env.logFile}`);
    assert.ok(fs.readFileSync(env.logFile, 'utf8').includes(env.logFile), '横幅里的日志路径要写进日志本身');

    // 优雅关闭：记名 → 关代理 → 关日志 → exit(0)。必须等 exited 兑现再收摊，
    // 否则还原掉的 process.exit 会被异步跑到的 shutdown 真的调一次。
    scope.fire('SIGINT');
    await scope.exited;

    const after = scope.stderrLines.join('');
    assert.match(after, /Received SIGINT, shutting down/i, '收到信号要记名');
    assert.match(after, /Stopped/i, '关完要说明已停止');
  } finally {
    scope.restore();
    process.exitCode = savedExitCode;
    env.restore();
  }
});

test('runCli 端口被占用时给出可读错误并以退出码 1 结束', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;

  const env = isolateEnv();
  const scope = instrumentProcess();
  const savedExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    await runCli(['--port', String(busyPort), '-u', 'http://127.0.0.1:1']);

    assert.equal(process.exitCode, 1, '起不来就必须以非零码结束');
    const text = scope.stderrLines.join('');
    assert.match(text, /EADDRINUSE|already in use/i, `要说明是端口被占用，实际：${text}`);
    assert.ok(
      text.includes(String(busyPort)) && text.includes(String(busyPort + 1)),
      '要给出被占用的端口和建议换的下一个端口',
    );
    assert.ok(!/listening/.test(text), '起不来就不该印「已监听」');
    // 这条路径只置退出码，不调用 process.exit——exited 不该兑现。
    // 顺序是先 installProcessGuards 再 listen，所以 listen 一挂就 return：
    // uncaughtException/unhandledRejection 两个兜底已经挂上，SIGINT/SIGTERM 还没轮到。
    const byEvent = new Map(scope.registered.map(([event]) => [event, 0]));
    for (const [event] of scope.registered) byEvent.set(event, byEvent.get(event) + 1);
    assert.equal(byEvent.get('uncaughtException'), 1, '兜底处理器照常挂上');
    assert.equal(byEvent.get('unhandledRejection'), 1, '兜底处理器照常挂上');
    assert.equal(byEvent.get('SIGINT') ?? 0, 0, 'listen 失败就返回，信号处理器还没轮到挂');
    assert.equal(byEvent.get('SIGTERM') ?? 0, 0, 'listen 失败就返回，信号处理器还没轮到挂');
  } finally {
    scope.restore();
    process.exitCode = savedExitCode;
    await new Promise((resolve) => blocker.close(resolve));
    env.restore();
  }
});
