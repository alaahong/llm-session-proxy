import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgv } from '../src/cli.js';
import { setLang } from '../src/messages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'llm-session-proxy.js');

const runCli = (args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

/** 等条件成立；超时就把最后一次的错误抛出去，避免用例永远挂着。 */
async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

test('parseArgv 解析监听地址与上游 URL', () => {
  const { flags } = parseArgv(['-p', '8080', '--host', '0.0.0.0', '-u', 'http://127.0.0.1:11434/v1']);

  assert.equal(flags.listen.port, 8080);
  assert.equal(flags.listen.host, '0.0.0.0');
  assert.equal(flags.upstream.protocol, 'http');
  assert.equal(flags.upstream.host, '127.0.0.1');
  assert.equal(flags.upstream.port, 11434);
  assert.equal(flags.upstream.basePath, '/v1');
});

test('parseArgv 同时支持 "--flag value" 与 "--flag=value"', () => {
  const spaced = parseArgv(['--port', '9000']);
  const inline = parseArgv(['--port=9000']);
  assert.equal(spaced.flags.listen.port, 9000);
  assert.equal(inline.flags.listen.port, 9000);

  const inlineUpstream = parseArgv(['--upstream=https://example.com/zen/go/v1']);
  assert.equal(inlineUpstream.flags.upstream.host, 'example.com');
  assert.equal(inlineUpstream.flags.upstream.basePath, '/zen/go/v1');
});

test('parseArgv 累积可重复的参数', () => {
  const { flags } = parseArgv([
    '--inject', 'x-a=1',
    '--inject', 'x-b={{session.id}}',
    '--model-map', 'fast=glm-5.3-flash',
    '--model-map', 'smart=glm-5.2',
    '--model-prefix', 'p1-',
    '--model-prefix', 'p2-',
    '--session-header', 'X-Custom-Session',
    '--session-field', 'meta.chat_id',
    '--path-rewrite', '^/v1/=>/zen/go/v1/',
    '--path-rewrite', '/responses$/=>/chat/completions',
  ]);

  assert.deepEqual(flags.inject.headers, { 'x-a': '1', 'x-b': '{{session.id}}' });
  assert.deepEqual(flags.model.map, { fast: 'glm-5.3-flash', smart: 'glm-5.2' });
  assert.deepEqual(flags.model.stripPrefixes, ['p1-', 'p2-']);
  assert.deepEqual(flags.session.headerNames, ['x-custom-session'], '头名应当统一小写');
  assert.deepEqual(flags.session.bodyFields, ['meta.chat_id']);
  assert.deepEqual(flags.request.pathRewrite, [
    { pattern: '^/v1/', replacement: '/zen/go/v1/' },
    { pattern: '/responses$/', replacement: '/chat/completions' },
  ]);
});

test('parseArgv 处理开关型与注入型参数', () => {
  const { flags } = parseArgv([
    '--no-session',
    '--no-stream',
    '--body-inject', 'temperature=0.2',
    '--body-inject', 'metadata.trace={{uuid}}',
    '--session-id-format', 'uuid',
    '--request-id-format', 'req-{{session.count}}',
    '--timeout', '120000',
    '--max-body', '1024',
    '--log-level', 'debug',
    '--log-file', './x.log',
    '--base-path', '/zen/go/v1',
  ]);

  assert.equal(flags.session.enabled, false);
  assert.equal(flags.response.stream, false);
  assert.deepEqual(flags.inject.body, { temperature: '0.2', 'metadata.trace': '{{uuid}}' });
  assert.equal(flags.session.idFormat, 'uuid');
  assert.equal(flags.session.requestIdFormat, 'req-{{session.count}}');
  assert.equal(flags.request.timeoutMs, 120000);
  assert.equal(flags.request.maxBodyBytes, 1024);
  assert.equal(flags.log.level, 'debug');
  assert.equal(flags.log.file, './x.log');
  assert.equal(flags.upstream.basePath, '/zen/go/v1');
});

test('parseArgv 支持日志目录、轮转与归档参数', () => {
  const { flags } = parseArgv([
    '--log-dir', './logs',
    '--log-rotate', 'DAILY',
    '--log-keep-days', '7',
  ]);

  assert.equal(flags.log.dir, './logs');
  assert.equal(flags.log.rotate, 'daily', '轮转方式应当统一小写');
  assert.equal(flags.log.keepDays, 7);

  // --no-log-file 是"关掉文件输出"的开关
  assert.equal(parseArgv(['--no-log-file']).flags.log.file, false);
  // 放在一起时以最后出现的为准
  assert.equal(parseArgv(['--log-file', './a.log', '--no-log-file']).flags.log.file, false);
});

test('parseArgv 识别本地工具开关', () => {
  assert.deepEqual(parseArgv(['--help']), { help: true });
  assert.deepEqual(parseArgv(['-h']), { help: true });
  assert.deepEqual(parseArgv(['--version']), { version: true });
  assert.deepEqual(parseArgv(['-v']), { version: true });

  const initWithPath = parseArgv(['--init', 'my-config.json']);
  assert.equal(initWithPath.initRequested, true);
  assert.equal(initWithPath.initFile, 'my-config.json');

  const initDefault = parseArgv(['--init']);
  assert.equal(initDefault.initRequested, true);
  assert.equal(initDefault.initFile, null);

  const printed = parseArgv(['--print-config', '-c', './custom.json']);
  assert.equal(printed.printConfig, true);
  assert.equal(printed.configFile, './custom.json');
});

test('parseArgv 空参数返回全默认的空片段', () => {
  const parsed = parseArgv([]);
  assert.deepEqual(parsed.flags, {});
  assert.equal(parsed.configFile, null);
  assert.equal(parsed.printConfig, false);
  assert.equal(parsed.initRequested, false);
});

test('parseArgv 对非法输入给出可读错误（默认英文）', () => {
  assert.throws(() => parseArgv(['--nope']), /Unrecognized argument/);
  assert.throws(() => parseArgv(['stray']), /Unrecognized argument/);
  assert.throws(() => parseArgv(['--port']), /requires a value/);
  assert.throws(() => parseArgv(['--port', '--host']), /requires a value/);
  assert.throws(() => parseArgv(['--inject', 'no-equals']), /name=value/);
  assert.throws(() => parseArgv(['--body-inject', 'no-equals']), /key=value/);
  assert.throws(() => parseArgv(['--model-map', 'only-alias']), /alias=real/);
  assert.throws(() => parseArgv(['--path-rewrite', 'no-arrow']), /regex=>replacement/);
});

test('parseArgv 识别 --lang 并归一化语言写法', () => {
  assert.equal(parseArgv(['--lang', 'zh']).flags.lang, 'zh');
  assert.equal(parseArgv(['--lang=zh-CN']).flags.lang, 'zh');
  assert.equal(parseArgv(['-l', 'en']).flags.lang, 'en');
  // 识别不了的写法先原样留下，由配置校验给出明确报错
  assert.equal(parseArgv(['--lang', 'fr']).flags.lang, 'fr');
});

test('parseArgv 的错误信息跟随 --lang 切换语言', () => {
  setLang('en');
  try {
    assert.throws(() => parseArgv(['--lang', 'zh', '--port']), /缺少取值/);
    assert.throws(() => parseArgv(['--lang=en', '--nope']), /Unrecognized argument/);
  } finally {
    setLang('en');
  }
});

test('CLI --version 输出语义化版本号', () => {
  assert.match(runCli(['--version']).trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI --help 打印用法并覆盖关键选项', () => {
  const output = runCli(['--help']);
  for (const flag of [
    '--inject',
    '--model-prefix',
    '--path-rewrite',
    '--print-config',
    '--init',
    '--lang',
    '--log-file',
    '--no-log-file',
    '--log-dir',
    '--log-rotate',
    '--log-keep-days',
  ]) {
    assert.ok(output.includes(flag), `帮助里应当提到 ${flag}`);
  }
});

test('CLI --help 默认英文，--lang zh 时给中文', () => {
  const english = runCli(['--help']);
  assert.ok(english.includes('A configurable local reverse proxy'), '默认帮助应当是英文');
  assert.ok(!/\p{Script=Han}/u.test(english), '默认帮助不应含中文');

  const chinese = runCli(['--lang', 'zh', '--help']);
  assert.ok(chinese.includes('本地反向代理'), '--lang zh 时帮助应当是中文');
});

test('CLI --print-config 输出可解析的 JSON，且命令行覆盖生效', () => {
  const config = JSON.parse(runCli(['--print-config', '-p', '4321', '--inject', 'x-a=1']));

  assert.equal(config.listen.port, 4321);
  assert.equal(config.upstream.host, 'opencode.ai');
  assert.equal(config.inject.headers['x-a'], '1');
  assert.equal(config.__configPath, undefined, '内部字段不应出现在输出里');
});

test('CLI --print-config 给出日志实际会写到哪里', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-home-'));
  const env = { ...process.env, LSP_HOME: home };
  const exec = (args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });

  const def = JSON.parse(exec(['--print-config']));
  assert.equal(def.log.file, null, 'file 保持 null 表示"用默认位置"');
  assert.equal(def.log.rotate, 'size');
  assert.equal(def.log.keepDays, 30);
  assert.equal(def.log.resolvedFile, path.join(home, 'logs', 'llm-session-proxy.log'));

  const custom = JSON.parse(exec(['--print-config', '--log-dir', path.join(home, 'custom'), '--log-rotate', 'daily', '--log-keep-days', '3']));
  assert.equal(custom.log.resolvedFile, path.join(home, 'custom', 'llm-session-proxy.log'));
  assert.equal(custom.log.rotate, 'daily');
  assert.equal(custom.log.keepDays, 3);

  const off = JSON.parse(exec(['--print-config', '--no-log-file']));
  assert.equal(off.log.file, false);
  assert.equal(off.log.resolvedFile, null, '关掉文件输出时没有解析出来的路径');
});

test('CLI 默认把日志写到 $LSP_HOME/logs 下，并在横幅里报出实际路径', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-run-'));
  const logFile = path.join(home, 'logs', 'llm-session-proxy.log');

  const child = spawn(process.execPath, [bin, '-p', '0', '-u', 'http://127.0.0.1:1'], {
    // 固定英文，横幅断言才不会被宿主机的 PROXY_LANG 影响
    env: { ...process.env, LSP_HOME: home, PROXY_LANG: 'en' },
    stdio: 'ignore',
  });

  try {
    await waitFor(() => {
      if (!fs.existsSync(logFile)) return false;
      // 等最后一个断言目标出现：日志是逐行 append，只等 'listening' 会撞上"还没写完"的竞态
      return fs.readFileSync(logFile, 'utf8').includes('size rotation');
    }, 10_000);

    const text = fs.readFileSync(logFile, 'utf8');
    assert.ok(text.includes(logFile), '横幅里的日志路径应当就是默认位置');
    assert.match(text, /keep 30 days/, '横幅里应当说明轮转与归档策略');
  } finally {
    child.kill();
  }
});

test('CLI --init 生成的配置能被自己解析并用于启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-'));
  const target = path.join(dir, 'config.json');

  assert.match(runCli(['--init', target]), /Sample config written/);
  assert.ok(fs.existsSync(target));

  const config = JSON.parse(runCli(['--print-config', '-c', target]));
  assert.equal(config.session.enabled, true);
  assert.equal(config.model.stripPrefixes.includes('proxy-'), true);
});

test('CLI --init --lang zh 生成中文注释的示例配置，且同样能解析', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-zh-'));
  const target = path.join(dir, 'config.json');

  assert.match(runCli(['--init', target, '--lang', 'zh']), /已生成示例配置/);
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(/\p{Script=Han}/u.test(text), '中文示例配置里应当有中文注释');

  const config = JSON.parse(runCli(['--print-config', '-c', target, '--lang', 'zh']));
  assert.equal(config.lang, 'zh', '配置文件里的 lang 应当被识别');
});

test('CLI --init 不覆盖已存在的文件，并以非零码退出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-'));
  const target = path.join(dir, 'config.json');
  runCli(['--init', target]);

  assert.throws(
    () => execFileSync(process.execPath, [bin, '--init', target], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 1,
  );
});

test('CLI 对非法参数以退出码 2 结束', () => {
  assert.throws(
    () => execFileSync(process.execPath, [bin, '--bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 2,
  );
});

test('CLI 对非法配置以退出码 2 结束', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"listen":{"port":99999}}', 'utf8');

  assert.throws(
    () => execFileSync(process.execPath, [bin, '--print-config', '-c', bad], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 2,
  );
});
