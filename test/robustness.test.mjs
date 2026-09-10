import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { installProcessGuards } from '../src/cli.js';
import { Logger } from '../src/logger.js';
import { createProxyServer } from '../src/proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 这一组测试守的是一条底线：**单个畸形请求不能让进程退出**。
 *
 * 背景：http 服务器的事件回调里冒出来的同步异常没有任何人接得住，
 * Node 会直接终止进程，而且栈只进 stderr、不进日志文件——
 * 现场表现就是「日志一切正常，进程凭空消失」。
 * 曾经有两个真实触发点：
 *   1. Host 头非法 -> new URL() 抛 ERR_INVALID_URL
 *   2. 上游 reason phrase 含控制字符 -> res.writeHead() 抛 ERR_INVALID_CHAR
 *
 * 这些用例跑在测试进程内，所以一旦回归，未捕获异常会让整个测试文件失败。
 */

async function startProxy(overrides = {}) {
  const config = deepMerge(DEFAULT_CONFIG, {
    listen: { host: '127.0.0.1', port: 0 },
    log: { level: 'silent' },
    ...overrides,
  });
  const logger = new Logger({ level: 'silent', console: false });
  const proxy = createProxyServer({ config, logger });
  await proxy.listen();
  return {
    proxy,
    url: `http://127.0.0.1:${proxy.server.address().port}`,
    port: proxy.server.address().port,
    close: async () => {
      await proxy.close();
      logger.close();
    },
  };
}

/** 会发送任意字节的假上游，用来构造 Node 正常测试造不出来的畸形响应。 */
async function startRawUpstream(responder) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let fired = false;
    socket.on('data', () => {
      if (fired) return;
      fired = true;
      responder(socket);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 原始 socket 客户端：可以发畸形请求行 / 畸形 Host。 */
function rawRequest(port, text, { waitMs = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let got = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
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
  const payload = await response.json();
  assert.equal(payload.ok, true);
  return payload;
}

test('Host 头非法时返回 400，且进程继续服务', async () => {
  const upstream = await startRawUpstream((socket) => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
  });
  const proxy = await startProxy({ upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port } });

  try {
    // 回归点：以前这里会抛 ERR_INVALID_URL，直接把进程带走
    const raw = await rawRequest(proxy.port, 'GET /zen/go/v1/chat/completions HTTP/1.1\r\nHost: foo bar\r\n\r\n');
    assert.match(raw, /^HTTP\/1\.1 400 /, `期望 400，实际收到: ${JSON.stringify(raw.slice(0, 80))}`);
    assert.match(raw, /bad_request_target/);

    // 关键断言：出过事之后还得能干活
    await assertStillServing(proxy.url);
    const followUp = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(followUp.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游 reason phrase 含控制字符时正常回传，且进程继续服务', async () => {
  const upstream = await startRawUpstream((socket) => {
    // 回归点：以前 Node 的入站解析能收下这个短语，但 res.writeHead() 会同步抛
    // ERR_INVALID_CHAR，把进程带走
    socket.write('HTTP/1.1 200 We\u0001ird\r\nContent-Length: 2\r\n\r\nok');
  });
  const proxy = await startProxy({ upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port } });

  try {
    const response = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(response.status, 200, '非法 reason phrase 应被丢弃，而不是让请求失败');
    assert.equal(await response.text(), 'ok');
    // 状态行的短语要么被丢掉用默认值，要么原样合法；绝不能带控制字符
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游响应头含非法字符时丢弃该头，而不是崩溃', async () => {
  const upstream = await startRawUpstream((socket) => {
    socket.write('HTTP/1.1 200 OK\r\nX-Weird: a\u0001b\r\nContent-Length: 2\r\n\r\nok');
  });
  const proxy = await startProxy({ upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port } });

  try {
    const response = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    assert.ok([200, 502].includes(response.status), `状态码 ${response.status} 不应是崩溃`);
    assert.equal(response.headers.get('x-weird'), null, '非法响应头应当被丢弃');
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('畸形请求行由 clientError 兜住，回 400 且进程继续服务', async () => {
  const proxy = await startProxy();

  try {
    const raw = await rawRequest(proxy.port, 'GET  HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.match(raw, /^HTTP\/1\.1 400 /);
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
  }
});

test('超大请求头回 431（保留 Node 默认语义）', async () => {
  const proxy = await startProxy();

  try {
    const raw = await rawRequest(
      proxy.port,
      `GET /zen/go/v1/chat/completions HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`,
      { waitMs: 600 },
    );
    assert.match(raw, /^HTTP\/1\.1 431 /);
    await assertStillServing(proxy.url);
  } finally {
    await proxy.close();
  }
});

test('客户端在请求体读完前断开不会留下悬空请求', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.address().port },
  });

  try {
    // 声明 5000 字节却只发一半就断开
    await new Promise((resolve) => {
      const socket = net.connect(proxy.port, '127.0.0.1');
      socket.on('error', () => {});
      socket.on('connect', () => {
        socket.write(
          'POST /zen/go/v1/chat/completions HTTP/1.1\r\nHost: x\r\n' +
            'Content-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"model":"a"',
        );
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 120);
      });
    });

    await assertStillServing(proxy.url);
    assert.equal(upstreamHits, 0, '请求体没读完就不该向上游发起请求');
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('上游在空闲时掐断 keep-alive 连接不会崩溃', async () => {
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive' });
      res.end('{}');
    });
  });
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.address().port },
  });

  try {
    // 先正常请求一次，让代理建立并缓存一条 keep-alive 连接
    const first = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(first.status, 200);
    await first.text();
    assert.ok(sockets.size >= 1, '应当有一条到上游的连接');

    await new Promise((r) => setTimeout(r, 150));

    // 上游粗暴掐断空闲连接：这类 socket 'error' 若无人接管同样是进程级崩溃
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => setTimeout(r, 300));

    await assertStillServing(proxy.url);
    // 连接池被清掉之后，新请求应当自动重建连接
    const second = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x' }),
    });
    assert.equal(second.status, 200);
  } finally {
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('installProcessGuards 会挂上未捕获异常与未处理拒绝的兜底，并且可以移除', () => {
  const logger = new Logger({ level: 'silent', console: false });
  const beforeUncaught = process.listenerCount('uncaughtException');
  const beforeRejection = process.listenerCount('unhandledRejection');

  installProcessGuards(logger);

  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught + 1);
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection + 1);

  // 清理，避免污染同一进程里的其他测试
  for (const listener of process.listeners('uncaughtException').slice(beforeUncaught)) {
    process.removeListener('uncaughtException', listener);
  }
  for (const listener of process.listeners('unhandledRejection').slice(beforeRejection)) {
    process.removeListener('unhandledRejection', listener);
  }

  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught);
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection);
});

test('端到端：未处理拒绝之后进程仍在运行，且栈写进了日志文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-guard-'));
  const logFile = path.join(dir, 'guard.log');
  const cliUrl = pathToFileURL(path.resolve(ROOT, 'src/cli.js')).href;
  const loggerUrl = pathToFileURL(path.resolve(ROOT, 'src/logger.js')).href;

  const code = `
    import { installProcessGuards } from ${JSON.stringify(cliUrl)};
    import { Logger } from ${JSON.stringify(loggerUrl)};
    const logger = new Logger({ level: 'info', console: false, file: ${JSON.stringify(logFile)} });
    installProcessGuards(logger);
    // 故意制造一个未处理的 Promise 拒绝：默认行为下这会立刻终止进程
    Promise.reject(new Error('故意制造的未处理拒绝'));
    setTimeout(() => { logger.info('守卫之后仍然活着'); }, 150);
    setTimeout(() => { process.exit(0); }, 400);
  `;

  const { code: exitCode, stderr } = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('exit', (c) => resolve({ code: c, stderr: err }));
  });

  try {
    assert.equal(exitCode, 0, `进程不应因未处理拒绝而异常退出，stderr:\n${stderr}`);
    const written = fs.readFileSync(logFile, 'utf8');
    assert.match(written, /unhandledRejection/, '日志文件里应当留下未处理拒绝的记录');
    assert.match(written, /故意制造的未处理拒绝/, '日志里应当带上原始错误信息');
    assert.match(written, /守卫之后仍然活着/, '进程应当继续执行后续代码');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
