/**
 * 代理层的失败分支补测。
 *
 * proxy.test.mjs 覆盖「正常请求走通」，proxy-errors.test.mjs 覆盖「上游连不上 / 超时 /
 * 超限」这类整段失败，robustness.test.mjs 守的是「畸形输入不能带崩进程」。
 * 这里补的是夹在中间的**局部失败**：上游回了个坏头、写响应写到一半客户端没了、
 * 协议互转转到了自己身上、上游池点名了一个不存在的上游……
 *
 * 这些分支的共同点是：局部失败不该放大成整条链路的失败，更不该放大成进程消失。
 *
 * 判据统一：代理层**绝不把客户端的请求变成进程级故障**。任何异常路径要么给出结构化
 * 错误答复（JSON + 明确 type），要么原样透传上游响应，**不许静默吞掉**；字段丢了要
 * **记名**（日志里有明确的 key），不许无声无息。
 *
 * 手段说明：有些分支用正常请求根本走不到（Node 的入站解析比出站校验还严格，
 * 上游发不出非法响应头）。这类分支用**可恢复的桩**把故障注入进来：临时替换
 * 某个原型方法或模块级函数，测完立刻还原。桩都写成 try/finally 保证还原，
 * 且都用请求头 / 局部标记限定作用范围，不影响同一进程里的其它测试。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { isForbiddenPort } from '../src/ports.js';
import { createProxyServer } from '../src/proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 独占标记：每个用例领一个**只属于自己**的判别值。
 *
 * 下面那些桩（writeHead / end / destroy / write / pipe …）都要替换 Node 的原型方法，
 * 而原型是**全进程共享**的：桩一动，同进程里所有请求都看得见。
 * 如果桩靠固定的 header 值判别（「=== '1'」），那么任何带着同名 header 的请求都会被
 * 误伤——包括同一文件里其它用例发的、以及别的测试文件碰巧用了同一个约定名的。
 * 表现为「明明不是我那条分支，却莫名其妙 fetch failed」。
 *
 * 所以这里发号：每个用例的判别值都不一样，桩只认自己那一个。
 * 这样桩的影响范围严格限定在「本用例发的那一个请求」上。
 * （`node --test` 目前串行跑同一文件里的用例，但这个约束本来就不该依赖那个事实。）
 */
let markSeq = 0;
function claimMark(prefix) {
  markSeq += 1;
  return `${prefix}-${process.pid}-${markSeq}`;
}

/** 收集各级日志的 logger：代理层只用到 error/warn/info/debug 四个方法。 */
function collectingLogger() {
  const logs = { error: [], warn: [], info: [], debug: [] };
  return {
    logs,
    logger: {
      error: (...args) => logs.error.push(args.join(' ')),
      warn: (...args) => logs.warn.push(args.join(' ')),
      info: (...args) => logs.info.push(args.join(' ')),
      debug: (...args) => logs.debug.push(args.join(' ')),
      close: () => {},
    },
  };
}

async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 起一个把日志收集起来的代理。 */
async function startProxy(overrides = {}) {
  const config = deepMerge(DEFAULT_CONFIG, {
    listen: { host: '127.0.0.1', port: 0 },
    log: { level: 'silent' },
    ...overrides,
  });
  const { logger, logs } = collectingLogger();
  const proxy = createProxyServer({ config, logger });
  await proxy.listen();
  return {
    proxy,
    config,
    logs,
    url: `http://127.0.0.1:${proxy.server.address().port}`,
    close: () => proxy.close(),
  };
}

/**
 * 带诊断信息的 fetch 包装。
 *
 * undici 的 `fetch failed` 是一个**不带原因**的 TypeError：真正的原因藏在
 * `error.cause` 里。不把 cause 挖出来，间歇性失败就只是一句「fetch failed」，谁也定位不到。
 *
 * 这个包装就是上一轮排查的产物：当时测试套件以约 6.7% 的概率随机失败，报的都是同一句
 * 无信息的 `fetch failed`。把 cause 拼进 message 之后，三次现场全是
 * `Error bad port`——OS 给 `listen(0)` 分配到了 6000 / 10080 / 5060 这类
 * WHATWG 禁用端口，undici 的 fetch 按规范在**发请求之前**就拒了。
 * 代理走 node:http/https，完全不受那份名单约束，所以「服务端一切正常，客户端一个都连不上」。
 * 根因找到后修在产品侧（src/ports.js），但这个包装留下来了：
 * 下次再冒出无信息的 fetch failed，至少能看见原因。
 */
async function fetchWithCause(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (error) {
    const cause = error?.cause;
    const detail = cause
      ? ` (cause: ${cause.code || cause.name || ''} ${cause.message || ''}`.trimEnd() + ')'
      : '';
    if (process.env.LSP_PROBE_FETCH_FAIL) {
      process.stderr.write(`[fetchfail] url=${url} detail=${detail}\n`);
    }
    throw new Error(`${error.message}${detail}`, { cause: error });
  }
}

const postJson = (url, body, headers = {}) =>
  fetchWithCause(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** 带超时的抓取：某些分支会故意让响应悬着不结束。 */
async function fetchWithTimeout(url, options = {}, ms = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 原始 socket 客户端：可以发畸形请求行。 */
function rawRequest(port, text, { waitMs = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let got = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // destroy 也可能被测试打的桩命中（原型级的桩是全局的），
      // 这里绝不能让异常逃出去：一旦逃出去，promise 永远不会 settle，
      // 整个测试文件会被卡死，而且 finally 里的还原桩也不会执行，
      // 后面所有测试都会被这根桩污染。
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(got);
    };
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      got += chunk.toString('latin1');
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
    setTimeout(finish, waitMs);
  });
}

/** 存活复查：代理还答得上本地健康端点。 */
async function assertStillServing(url) {
  const response = await fetch(`${url}/__llm_session_proxy__/health`);
  assert.equal(response.status, 200, '代理应当仍然存活并响应健康检查');
  return response.json();
}

/** 在子进程里跑一段脚本，返回退出码与输出。用于「崩了也不能拖垮测试进程」的断言。 */
function runChild(code) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const jsonUpstream = (body = '{"ok":true}') => (req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
};

const CHAT_SSE = [
  'data: {"id":"cmpl-1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

// ==================================================================
// 一、响应头清洗：非法字符的丢弃与记名
// ==================================================================

test('上游响应头含非法字符时丢掉该头并记名（标量与数组两种形态）', async () => {
  const originalRequest = http.request;
  // Node 的入站解析比出站写入严格，上游发不出非法头——所以直接注入。
  // 注入的三个头分别对应：标量非法、数组全部非法、数组部分非法。
  http.request = function patched(options, callback) {
    if (typeof callback !== 'function') return originalRequest.apply(this, arguments);
    return originalRequest.call(this, options, (res) => {
      res.headers['x-bad-scalar'] = 'a\u0001b';
      res.headers['x-bad-array'] = ['a\u0001b'];
      res.headers['set-cookie'] = ['ok=1', 'bad=\u0001'];
      callback(res);
    });
  };

  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-bad-scalar'), null, '非法的标量响应头应当被丢弃');
    assert.equal(response.headers.get('x-bad-array'), null, '整组非法的数组响应头应当被丢弃');
    assert.deepEqual(response.headers.getSetCookie(), ['ok=1'], '数组里合法的项应当保留');

    // 判据：字段丢了要记名。三种丢弃都要在日志里留下明确的 key。
    const dropped = proxy.logs.warn.filter((line) => line.includes('illegal characters'));
    assert.equal(dropped.length, 3, `三个被丢弃的头都要记名，实际：${JSON.stringify(dropped)}`);
    assert.ok(dropped.some((line) => line.includes('x-bad-scalar')));
    assert.ok(dropped.some((line) => line.includes('x-bad-array')));
    assert.ok(
      dropped.some((line) => line.includes('set-cookie')),
      `部分非法的数组头丢了内容也必须记名，实际：${JSON.stringify(dropped)}`,
    );
  } finally {
    http.request = originalRequest;
    await proxy.close();
    await upstream.close();
  }
});

test('响应体超过 1KB / 1MB 时日志里的字节数换算成 KB / MB', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      const size = Number(req.headers['x-body-size'] || 1024);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pad: 'x'.repeat(size) }));
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await (await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'x-body-size': '2048' })).text();
    await (
      await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'x-body-size': String(2 * 1024 * 1024) })
    ).text();

    const sizes = proxy.logs.info
      .filter((line) => line.startsWith('[res]'))
      .map((line) => (line.match(/(\d+(?:\.\d+)?(?:B|KB|MB))\s/) || [])[1]);
    assert.ok(sizes.includes('2.0KB'), `应当有一条 KB 记录，实际：${JSON.stringify(sizes)}`);
    assert.ok(sizes.includes('2.0MB'), `应当有一条 MB 记录，实际：${JSON.stringify(sizes)}`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 二、respondJson：头已发出 / 写失败
// ==================================================================

test('响应头已经发出时 respondJson 只结束响应，不再写第二份头', async () => {
  const mark = claimMark('x-force-headers-sent');
  const descriptor = Object.getOwnPropertyDescriptor(http.OutgoingMessage.prototype, 'headersSent');
  const originalGet = descriptor.get;
  // 让这一个请求的 headersSent 恒为真：走「头已发出」那条分支。
  Object.defineProperty(http.OutgoingMessage.prototype, 'headersSent', {
    configurable: true,
    enumerable: true,
    get() {
      if (this.req?.headers?.['x-force-headers-sent'] === mark) return true;
      return originalGet.call(this);
    },
  });

  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await fetch(`${proxy.url}/__llm_session_proxy__/nope`, {
      headers: { 'x-force-headers-sent': mark },
    });
    assert.equal(await response.text(), '', '头已发出时不能再塞第二份响应体');
    await assertStillServing(proxy.url);
  } finally {
    Object.defineProperty(http.OutgoingMessage.prototype, 'headersSent', descriptor);
    await proxy.close();
    await upstream.close();
  }
});

test('回写响应时 writeHead 抛错：记一笔并断开连接，代理继续服务', async () => {
  const mark = claimMark('x-boom-writehead');
  const originalWriteHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function patched(...args) {
    if (this.req?.headers?.['x-boom-writehead'] === mark) throw new Error('boom-writehead');
    return originalWriteHead.apply(this, args);
  };

  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    // 未知本地端点会走 respondJson -> writeHead -> 抛错。
    await assert.rejects(
      () => fetch(`${proxy.url}/__llm_session_proxy__/nope`, { headers: { 'x-boom-writehead': mark } }),
      (error) => error instanceof Error,
      '写不出去就该让客户端知道，而不是装作成功',
    );
    assert.ok(
      proxy.logs.debug.some((line) => line.includes('failed to write the response')),
      `写响应失败要记名，实际：${JSON.stringify(proxy.logs.debug)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.writeHead = originalWriteHead;
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 三、writeResponseHead：重试与放弃
// ==================================================================

test('writeHead 第一次抛错时重试一次，重试成功则正常回包', async () => {
  const mark = claimMark('x-boom-writehead-once');
  const originalWriteHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function patched(...args) {
    if (this.req?.headers?.['x-boom-writehead-once'] === mark && !this.__boomed) {
      this.__boomed = true;
      throw new Error('boom-writehead-once');
    }
    return originalWriteHead.apply(this, args);
  };

  const upstream = await startUpstream(jsonUpstream('{"ok":1}'));
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    // 打桩标记头不能转发给上游：ServerResponse 是全局原型，
    // 上游自己的响应也会撞上这个桩（那就成了「上游服务器炸了」而不是「代理的分支」）。
    request: { dropHeaders: ['x-boom-writehead-once'] },
  });

  try {
    const response = await postJson(
      `${proxy.url}/v1/chat/completions`,
      { model: 'm', messages: [] },
      { 'x-boom-writehead-once': mark },
    );
    assert.equal(response.status, 200, '重试成功就应当照常回包');
    assert.equal(await response.text(), '{"ok":1}');
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('writeHead failed')),
      `重试要留痕，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
  } finally {
    http.ServerResponse.prototype.writeHead = originalWriteHead;
    await proxy.close();
    await upstream.close();
  }
});

test('writeHead 一直抛错时放弃这次响应：记名、断开连接、代理继续服务', async () => {
  const mark = claimMark('x-boom-writehead-always');
  const originalWriteHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function patched(...args) {
    if (this.req?.headers?.['x-boom-writehead-always'] === mark) throw new Error('boom-writehead-always');
    return originalWriteHead.apply(this, args);
  };

  const upstream = await startUpstream(jsonUpstream('{"ok":1}'));
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { dropHeaders: ['x-boom-writehead-always'] },
  });

  try {
    await assert.rejects(
      () => postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'x-boom-writehead-always': mark }),
      (error) => error instanceof Error,
    );
    assert.ok(
      proxy.logs.error.some((line) => line.includes('giving up')),
      `放弃时要记名，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('writeHead failed')),
      `重试也要留痕，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.writeHead = originalWriteHead;
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 四、本地端点与同步兜底
// ==================================================================

test('未知的本地端点回 404，错误体带明确的 type', async () => {
  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await fetch(`${proxy.url}/__llm_session_proxy__/nope`);
    assert.equal(response.status, 404);
    const payload = await response.json();
    // 判据：异常路径的答复要么是结构化错误（JSON + 明确 type），要么原样透传。
    assert.equal(payload.error.type, 'unknown_endpoint', '404 必须带明确的 type');
    assert.match(payload.error.message, /nope/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('请求处理过程中同步抛错时兜成 500，而不是让异常逃出去', async () => {
  const mark = claimMark('x-boom-req-on');
  const originalOn = http.IncomingMessage.prototype.on;
  http.IncomingMessage.prototype.on = function patched(event, listener) {
    if (event === 'error' && this.headers?.['x-boom-req-on'] === mark) {
      throw new Error('boom-req-on');
    }
    return originalOn.call(this, event, listener);
  };

  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { dropHeaders: ['x-boom-req-on'] },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'x-boom-req-on': mark });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_internal_error');
    assert.ok(
      proxy.logs.error.some((line) => line.includes('threw while handling the request')),
      `同步兜底要留痕，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.IncomingMessage.prototype.on = originalOn;
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 五、上游池
// ==================================================================

test('上游池点名了但没这个 provider 时告警，并回退到默认上游', async () => {
  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    upstreams: {
      providers: {},
      routes: [{ model: 'ghost-model', upstream: 'ghost' }],
    },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'ghost-model', messages: [] });
    assert.equal(response.status, 200, '没配 provider 就该回退到默认上游，而不是报错');
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('ghost')),
      `点名了不存在的上游要喊一声，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('userAgentMode=keep 时客户端的 UA 原样透传给上游', async () => {
  const seen = [];
  const upstream = await startUpstream((req, res) => {
    seen.push(req.headers['user-agent']);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    userAgentMode: 'keep',
  });

  try {
    await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'user-agent': 'MyClient/9.9' }).then((r) =>
      r.text(),
    );
    assert.equal(seen[0], 'MyClient/9.9', 'keep 模式下客户端 UA 应当原样透传');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 六、构造上游请求失败 / 写上游失败 / 兜底
// ==================================================================

test('注入的请求头名非法时回 502（proxy_request_build_error），不崩进程', async () => {
  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    // buildInjectHeaders 不校验 header 名的合法性——非法名会让 http.request 同步抛。
    inject: { headers: { 'x bad name': 'v' } },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_request_build_error');
    assert.ok(payload.error.upstream, '错误体要说明是哪个上游');
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('写上游请求体失败时回 502 并记名', async () => {
  const mark = claimMark('x-boom-write');
  const originalWrite = http.ClientRequest.prototype.write;
  http.ClientRequest.prototype.write = function patched(...args) {
    if (this.getHeader?.('x-boom-write') === mark) throw new Error('boom-write-upstream');
    return originalWrite.apply(this, args);
  };

  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'x-boom-write': mark });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_upstream_error');
    assert.ok(
      proxy.logs.error.some((line) => line.includes('failed to write the upstream request')),
      `写上游失败要记名，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.ClientRequest.prototype.write = originalWrite;
    await proxy.close();
    await upstream.close();
  }
});

test('pathRewrite 的正则非法时兜成 500，而不是让异常逃出去', async () => {
  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { pathRewrite: [{ pattern: '(', replacement: '/' }] },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_internal_error');
    assert.ok(
      proxy.logs.error.some((line) => line.includes('threw while handling the request')),
      `兜底要留痕，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 七、上游响应流中途出错
// ==================================================================

test('上游响应流中途断开（还没发头）时回 502（proxy_upstream_stream_error）', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"partial":');
    setTimeout(() => res.socket?.destroy(), 30);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    response: { stream: false },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_upstream_stream_error');
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游响应流中途断开（已发头）时销毁客户端连接，代理继续服务', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"partial":true}\n\n');
    // 回完头就掐断：代理已经给客户端发过头了，这时候上游再出错
    // 就只能断开客户端连接——不能再补一个 502（头都发出去了）。
    setTimeout(() => res.socket?.destroy(), 30);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await assert.rejects(
      () => postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }).then((r) => r.text()),
      (error) => error instanceof Error,
      '连接被掐断，客户端应当看到失败而不是一个永远不结束的响应',
    );
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('upstream response stream error')),
      `上游流出错要记名，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('销毁客户端连接本身也出错时，代理不崩进程也不挂死', async () => {
  const mark = claimMark('x-boom-destroy');
  const originalDestroy = http.ServerResponse.prototype.destroy;
  http.ServerResponse.prototype.destroy = function patched(...args) {
    if (this.req?.headers?.['x-boom-destroy'] === mark) throw new Error('boom-destroy');
    return originalDestroy.apply(this, args);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"partial":true}\n\n');
    setTimeout(() => res.socket?.destroy(), 30);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { dropHeaders: ['x-boom-destroy'] },
  });

  try {
    // 销毁连接失败 → 客户端这头就一直等着，所以给个超时兜底。
    // 注意超时罩的是**读 body**，不只是 fetch 本身：响应头早就到了，
    // 卡住的是 body 流。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(`${proxy.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-boom-destroy': mark },
        body: JSON.stringify({ model: 'm', messages: [] }),
        signal: controller.signal,
      });
      await assert.rejects(
        () => response.text(),
        (error) => error instanceof Error,
        '连接被掐断后客户端应当看到失败，而不是一直挂着',
      );
    } finally {
      clearTimeout(timer);
    }
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('upstream response stream error')),
      `上游流出错要记名，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.destroy = originalDestroy;
    await proxy.close();
    await upstream.close();
  }
});

test('上游回完头就卡住时超时销毁连接，代理继续服务', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"partial":true}\n\n');
    // 故意不结束，等代理侧超时
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { timeoutMs: 200 },
  });

  try {
    const response = await fetchWithTimeout(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    assert.equal(response.status, 200, '上游的头已经转给了客户端');
    await assert.rejects(
      () => response.text(),
      (error) => error instanceof Error,
      '超时后连接应当被掐断，而不是一直挂着',
    );
    assert.ok(
      proxy.logs.error.some((line) => line.includes('Upstream did not respond within')),
      `超时要记名，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 八、协议互转的边界分支
// ==================================================================

test('请求被转写但上游回的既不是 SSE 也不是 JSON 时记一笔并原样透传', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain text');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/messages`, {
      model: 'test-model',
      system: 'be brief',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'plain text', '认不出来的响应类型原样透传');
    assert.ok(
      proxy.logs.debug.some((line) => line.includes('forwarding it converted but not streamed')),
      `兜不住时要留痕，实际：${JSON.stringify(proxy.logs.debug)}`,
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('转码写客户端时 res.write 抛错被吞掉，代理继续服务', async () => {
  const mark = claimMark('x-boom-res-write');
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function patched(...args) {
    if (this.req?.headers?.['x-boom-res-write'] === mark) throw new Error('boom-res-write');
    return originalWrite.apply(this, args);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(CHAT_SSE);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
  });

  try {
    await fetchWithTimeout(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-boom-res-write': mark },
      body: JSON.stringify({
        model: 'test-model',
        system: 'be brief',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }).catch(() => null);
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.write = originalWrite;
    await proxy.close();
    await upstream.close();
  }
});

test('转码收尾时抛错被记名，代理继续服务', async () => {
  const originalStringify = JSON.stringify;
  // 只让 message_stop 这个事件序列化失败——它是转码收尾时才发的。
  JSON.stringify = function patched(value, ...rest) {
    if (value && typeof value === 'object' && value.type === 'message_stop') throw new Error('boom-finalize');
    return originalStringify.call(JSON, value, ...rest);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    // 故意不带 [DONE]：收尾只会在流结束时发生。
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"id":"cmpl-1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
  });

  try {
    await fetchWithTimeout(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        system: 'be brief',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }).catch(() => null);
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('protocol conversion chat->messages failed')),
      `转码失败要记名，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    JSON.stringify = originalStringify;
    await proxy.close();
    await upstream.close();
  }
});

test('转码分支里 res.end 抛错被吞掉，代理继续服务', async () => {
  const mark = claimMark('x-boom-res-end');
  const originalEnd = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function patched(...args) {
    if (this.req?.headers?.['x-boom-res-end'] === mark) throw new Error('boom-res-end');
    return originalEnd.apply(this, args);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(CHAT_SSE);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
    // 桩挂在 http.ServerResponse.prototype 上，是全进程共享的。
    // 假上游和代理用的是同一个原型，所以必须让这个标记头**不被转发到上游**，
    // 否则上游的 res.end 也会被桩命中，炸的就不是代理而是上游了。
    request: { dropHeaders: ['x-boom-res-end'] },
  });

  try {
    await fetchWithTimeout(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-boom-res-end': mark },
      body: JSON.stringify({
        model: 'test-model',
        system: 'be brief',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }).catch(() => null);
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.end = originalEnd;
    await proxy.close();
    await upstream.close();
  }
});

test('转码后的 JSON 不是合法 JSON 时原样透传', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not-json-at-all');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/messages`, {
      model: 'test-model',
      system: 'be brief',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'not-json-at-all', '不是合法 JSON 就原样透传');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('转码后的 JSON 写不出去时记名并断开连接，代理继续服务', async () => {
  const mark = claimMark('x-boom-res-end');
  const originalEnd = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function patched(...args) {
    if (this.req?.headers?.['x-boom-res-end'] === mark) throw new Error('boom-res-end');
    return originalEnd.apply(this, args);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [] }));
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
    request: { dropHeaders: ['x-boom-res-end'] },
  });

  try {
    await assert.rejects(
      () =>
        postJson(`${proxy.url}/v1/messages`, {
          model: 'test-model',
          system: 'be brief',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }, { 'x-boom-res-end': mark }).then((r) => r.text()),
      (error) => error instanceof Error,
    );
    assert.ok(
      proxy.logs.error.some((line) => line.includes('failed to write the buffered response')),
      `回写缓冲响应失败要记名，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.end = originalEnd;
    await proxy.close();
    await upstream.close();
  }
});

test('透传分支里管道连接失败时记名并断开连接，代理继续服务', async () => {
  const mark = claimMark('x-boom-pipe');
  const originalPipe = http.IncomingMessage.prototype.pipe;
  http.IncomingMessage.prototype.pipe = function patched(...args) {
    if (this.req?.getHeader?.('x-boom-pipe') === mark) throw new Error('boom-pipe');
    return originalPipe.apply(this, args);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await assert.rejects(
      () => postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] }, { 'x-boom-pipe': mark }).then((r) => r.text()),
      (error) => error instanceof Error,
    );
    assert.ok(
      proxy.logs.warn.some((line) => line.includes('pipe failed')),
      `管道失败要记名，实际：${JSON.stringify(proxy.logs.warn)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.IncomingMessage.prototype.pipe = originalPipe;
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 九、非流式模式下的整包转码
// ==================================================================

test('非流式模式下 SSE 响应被整包转码', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(CHAT_SSE);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
    response: { stream: false },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/messages`, {
      model: 'test-model',
      system: 'be brief',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.match(raw, /event: message_start/, '整包转码也要转成客户端协议');
    assert.match(raw, /event: message_stop/);
    assert.equal(
      Number(response.headers.get('content-length')),
      Buffer.byteLength(raw),
      '转码后 content-length 要跟实际长度对上',
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('非流式模式下 JSON 不是合法 JSON 时原样透传', async () => {
  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
    response: { stream: false },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/messages`, {
      model: 'test-model',
      system: 'be brief',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    assert.equal(await response.text(), '{not json');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('非流式模式下回写缓冲响应失败时记名并断开连接，代理继续服务', async () => {
  const mark = claimMark('x-boom-res-end');
  const originalEnd = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function patched(...args) {
    if (this.req?.headers?.['x-boom-res-end'] === mark) throw new Error('boom-res-end');
    return originalEnd.apply(this, args);
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', choices: [] }));
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
    response: { stream: false },
    request: { dropHeaders: ['x-boom-res-end'] },
  });

  try {
    await assert.rejects(
      () =>
        postJson(`${proxy.url}/v1/messages`, {
          model: 'test-model',
          system: 'be brief',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }, { 'x-boom-res-end': mark }).then((r) => r.text()),
      (error) => error instanceof Error,
    );
    assert.ok(
      proxy.logs.error.some((line) => line.includes('failed to write the buffered response')),
      `回写缓冲响应失败要记名，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    http.ServerResponse.prototype.end = originalEnd;
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 十、Copilot 凭据
// ==================================================================

test('Copilot 走设备流登录：设备码要显示给用户，session token 装进请求头', async () => {
  const originalRequest = https.request;
  https.request = function patched(options, callback) {
    const req = new EventEmitter();
    req.write = () => true;
    req.destroy = () => {};
    req.setTimeout = () => {};
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        let body = '{}';
        if (options.path.includes('device/code')) {
          body = JSON.stringify({
            device_code: 'dev-1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://example.test/device',
            expires_in: 900,
          });
        } else if (options.path.includes('access_token')) {
          body = JSON.stringify({ access_token: 'gho_device', scope: '' });
        } else if (options.path.includes('copilot_internal')) {
          body = JSON.stringify({ token: 'session-token-xyz', expires_at: Math.floor(Date.now() / 1000) + 1800 });
        }
        if (typeof callback === 'function') callback(res);
        else req.emit('response', res);
        setImmediate(() => {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      });
    };
    return req;
  };

  const seen = [];
  const upstream = await startUpstream((req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  const saved = {};
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-copilot-branch-'));
  const savedHome = process.env.LSP_HOME;
  process.env.LSP_HOME = home;

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    upstreams: {
      providers: {
        c: { type: 'copilot', baseUrl: `http://127.0.0.1:${upstream.port}`, auth: { allowCommand: false, deviceFlow: true } },
      },
      default: 'c',
    },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'gpt-4o', messages: [] });
    assert.equal(response.status, 200);
    assert.equal(seen[0], 'Bearer session-token-xyz', 'session token 要装进 authorization 头');
    assert.ok(
      proxy.logs.info.some((line) => line.includes('ABCD-1234')),
      `设备码要显示给用户，实际：${JSON.stringify(proxy.logs.info)}`,
    );
  } finally {
    https.request = originalRequest;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (savedHome === undefined) delete process.env.LSP_HOME;
    else process.env.LSP_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    await proxy.close();
    await upstream.close();
  }
});

test('上游池的 provider 配了 auth 但取不到 key 时记一笔，放行让上游自己回 401', async () => {
  const upstream = await startUpstream(jsonUpstream());
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    upstreams: {
      providers: {
        g: { type: 'gemini', baseUrl: `http://127.0.0.1:${upstream.port}`, auth: { env: 'LSP_BRANCH_MISSING_KEY' } },
      },
      default: 'g',
    },
  });

  try {
    const response = await postJson(`${proxy.url}/v1/chat/completions`, { model: 'm', messages: [] });
    assert.equal(response.status, 200, '取不到 key 不该由代理拦下');
    assert.ok(
      proxy.logs.debug.some((line) => line.includes('no API key found')),
      `取不到 key 要记名，实际：${JSON.stringify(proxy.logs.debug)}`,
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ==================================================================
// 十一、服务器层：畸形请求与启动错误
// ==================================================================

test('畸形请求导致 socket 结束时出错，兜底不崩进程', async () => {
  // 只在「代理服务端自己 accept 出来的 socket」上打桩。
  // net.Socket.prototype 是全局的：客户端 socket、server.close() 里的
  // closeIdleConnections、子进程的 stdout 管道全都是它。
  // 一旦桩被误伤，异常会从 finish() 之类的回调里逃出去，
  // 既会把本用例卡死，也会让 finally 里的还原桩执行不到，
  // 结果就是后面所有测试都被这根桩污染。
  //
  // 代理侧的 socket 靠 server 自己的 'connection' 事件认领：
  // 先接住 socket，再在 clientError 时把它标记成「要打桩的那一个」。
  const originalEnd = net.Socket.prototype.end;
  const originalDestroy = net.Socket.prototype.destroy;
  let armed = false;
  let target = null;
  net.Socket.prototype.end = function patched(...args) {
    if (armed && this === target) throw new Error('boom-socket-end');
    return originalEnd.apply(this, args);
  };
  net.Socket.prototype.destroy = function patched(...args) {
    if (armed && this === target) throw new Error('boom-socket-destroy');
    return originalDestroy.apply(this, args);
  };

  const proxy = await startProxy({});
  proxy.proxy.server.on('connection', (socket) => {
    target = socket;
  });

  try {
    armed = true;
    await rawRequest(proxy.proxy.server.address().port, 'GET  HTTP/1.1\r\nHost: x\r\n\r\n');
    armed = false;
    assert.ok(
      proxy.logs.debug.some((line) => line.includes('failed to parse the request')),
      `畸形请求要记名，实际：${JSON.stringify(proxy.logs.debug)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    armed = false;
    net.Socket.prototype.end = originalEnd;
    net.Socket.prototype.destroy = originalDestroy;
    await proxy.close();
  }
});

test('端口被占用时 listen 失败并 reject', async () => {
  const blocker = await startUpstream(jsonUpstream());
  const config = deepMerge(DEFAULT_CONFIG, {
    listen: { host: '127.0.0.1', port: blocker.port },
    log: { level: 'silent' },
  });
  const { logger } = collectingLogger();
  const proxy = createProxyServer({ config, logger });

  try {
    await assert.rejects(
      () => proxy.listen(),
      (error) => error.code === 'EADDRINUSE',
      '端口被占用时必须明确失败，而不是悄悄起不来',
    );
  } finally {
    await proxy.close();
    await blocker.close();
  }
});

test('自动分配端口时不会落在 WHATWG 禁用端口上（那种端口客户端按规范连不上）', async () => {
  // OS 给 listen(0) 分配到的端口有可能撞上 6000 / 6666 / 10080 这类禁用端口：
  // 代理绑得上，但浏览器和 fetch 客户端会直接拒绝连接——「起来了却谁都连不上」。
  // 这是测试套件间歇性 fetch failed 的根因，所以在代理层钉死：随机端口永远要能连。
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    const proxy = await startProxy({});
    try {
      const port = proxy.proxy.server.address().port;
      seen.push(port);
      assert.equal(isForbiddenPort(port), false, `自动分配到了禁用端口 ${port}`);
      await assertStillServing(proxy.url);
    } finally {
      await proxy.close();
    }
  }
  assert.equal(new Set(seen).size, seen.length, '每一轮都该拿到不同的端口');
});

test('监听成功后再冒出来的 server error 被记名，进程继续运行', async () => {
  const proxy = await startProxy({});

  try {
    const before = proxy.proxy.stats.errors;
    proxy.proxy.server.emit('error', new Error('boom-server'));
    assert.equal(proxy.proxy.stats.errors, before + 1);
    assert.ok(
      proxy.logs.error.some((line) => line.includes('server error')),
      `服务器错误要记名，实际：${JSON.stringify(proxy.logs.error)}`,
    );
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
  }
});

// ==================================================================
// 十二、进程级故障：必须跑在子进程里
// ==================================================================

/**
 * 协议互转 + 上游池的 wire 二次互转可能把响应转成「chat -> chat」，
 * 而转码器对 from === to 是直接抛错的。那个抛错点落在 http 的 'response'
 * 事件回调里——上面那层 try/catch 接不住，于是整个进程就消失了。
 *
 * 这里在子进程里跑：断言的是「子进程活着并且给出了答复」。
 */
test('协议互转与上游池二次互转到同一协议时，代理不会崩进程', async () => {
  const configUrl = pathToFileURL(path.join(ROOT, 'src/config.js')).href;
  const proxyUrl = pathToFileURL(path.join(ROOT, 'src/proxy.js')).href;
  const code = `
import http from 'node:http';
import { DEFAULT_CONFIG, deepMerge } from ${JSON.stringify(configUrl)};
import { createProxyServer } from ${JSON.stringify(proxyUrl)};

const upstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\\n\\ndata: [DONE]\\n\\n');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const port = upstream.address().port;

const config = deepMerge(DEFAULT_CONFIG, {
  listen: { host: '127.0.0.1', port: 0 },
  log: { level: 'silent' },
  upstream: { protocol: 'http', host: '127.0.0.1', port },
  protocol: {
    enabled: true,
    routes: [{ model: 'test-model', target: 'messages' }],
    paths: { chat: '/up/chat', messages: '/up/messages', responses: '/up/responses' },
  },
  upstreams: {
    providers: { oa: { type: 'openai', baseUrl: 'http://127.0.0.1:' + port } },
    default: 'oa',
  },
});
const logger = { error() {}, warn() {}, info() {}, debug() {}, close() {} };
const proxy = createProxyServer({ config, logger });
await proxy.listen();
const res = await fetch('http://127.0.0.1:' + proxy.server.address().port + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
});
console.log('STATUS=' + res.status);
const body = await res.text();
console.log('BODY=' + body.slice(0, 120));
await proxy.close();
await new Promise((r) => upstream.close(r));
`;
  const result = await runChild(code);
  assert.equal(result.code, 0, `代理进程不该崩溃，stderr:\n${result.stderr}`);
  assert.match(result.stdout, /STATUS=200/, `应当照常答复，实际输出：${result.stdout}`);
});

/**
 * 转码器在 'data' 回调里抛错，同样落在 http 的事件回调里——同样没人接得住。
 */
test('转码器在流式转发中抛错时，代理不会崩进程', async () => {
  const configUrl = pathToFileURL(path.join(ROOT, 'src/config.js')).href;
  const proxyUrl = pathToFileURL(path.join(ROOT, 'src/proxy.js')).href;
  const code = `
import http from 'node:http';
import { DEFAULT_CONFIG, deepMerge } from ${JSON.stringify(configUrl)};
import { createProxyServer } from ${JSON.stringify(proxyUrl)};

const originalStringify = JSON.stringify;
JSON.stringify = function (value, ...rest) {
  if (value && typeof value === 'object' && value.type === 'message_stop') throw new Error('boom-finalize');
  return originalStringify.call(JSON, value, ...rest);
};

const upstream = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\\n\\ndata: [DONE]\\n\\n');
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const port = upstream.address().port;

const config = deepMerge(DEFAULT_CONFIG, {
  listen: { host: '127.0.0.1', port: 0 },
  log: { level: 'silent' },
  upstream: { protocol: 'http', host: '127.0.0.1', port },
  protocol: { enabled: true, forced: 'chat' },
});
const logger = { error() {}, warn() {}, info() {}, debug() {}, close() {} };
const proxy = createProxyServer({ config, logger });
await proxy.listen();
const base = 'http://127.0.0.1:' + proxy.server.address().port;
try {
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', system: 'x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  console.log('STATUS=' + res.status);
  await res.text().catch(() => '');
} catch (error) {
  console.log('CLIENT_ERROR=' + error.message);
}
const health = await fetch(base + '/__llm_session_proxy__/health');
console.log('ALIVE=' + health.status);
await proxy.close();
await new Promise((r) => upstream.close(r));
`;
  const result = await runChild(code);
  assert.equal(result.code, 0, `代理进程不该崩溃，stderr:\n${result.stderr}`);
  assert.match(result.stdout, /ALIVE=200/, `代理应当还活着，实际输出：${result.stdout}`);
});
