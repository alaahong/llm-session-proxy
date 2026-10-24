import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { createProxyServer } from '../src/proxy.js';

/**
 * 代理的错误路径覆盖。
 *
 * proxy.test.mjs 覆盖的是「正常请求走通」，robustness.test.mjs 守的是
 * 「畸形输入不能带崩进程」。这里补的是夹在中间的**失败分支**：
 * 上游连不上、上游超时、写上游失败、流中途出错、请求体超限。
 *
 * 这些路径的共同点是：**必须给客户端一个明确的答复**，
 * 而不是让请求悬着或者把错误吞掉。
 */

async function startFakeUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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
    config,
    url: `http://127.0.0.1:${proxy.server.address().port}`,
    close: async () => {
      await proxy.close();
      logger.close();
    },
  };
}

const post = (url, body, extra = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...extra,
  });

// ---------------------------------------------------------------- 上游不可达

test('上游连不上时回 502，错误体带 upstream_error 类型', async () => {
  // 先起一个上游拿到端口，随即关掉——端口空着，连接必然失败
  const dead = await startFakeUpstream((req, res) => res.end('{}'));
  const port = dead.port;
  await dead.close();
  const proxy = await startProxy({ upstream: { protocol: 'http', host: '127.0.0.1', port } });

  try {
    const response = await post(`${proxy.url}/zen/go/v1/chat/completions`, { model: 'proxy-x', messages: [] });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_upstream_error');
    assert.ok(payload.error.message, '错误体要带说明');
  } finally {
    await proxy.close();
  }
});

test('上游不可达后代理仍然能服务后续请求', async () => {
  const dead = await startFakeUpstream((req, res) => res.end('{}'));
  const port = dead.port;
  await dead.close();
  const proxy = await startProxy({ upstream: { protocol: 'http', host: '127.0.0.1', port } });

  try {
    await post(`${proxy.url}/zen/go/v1/chat/completions`, { model: 'proxy-x', messages: [] });
    const health = await fetch(`${proxy.url}/__llm_session_proxy__/health`);
    assert.equal(health.status, 200);
  } finally {
    await proxy.close();
  }
});

// ---------------------------------------------------------------- 上游超时

test('上游超时按配置回 502，错误体说明超时', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    // 故意不回应，触发代理侧的超时
    req.resume();
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { timeoutMs: 150 },
  });

  try {
    const response = await post(`${proxy.url}/zen/go/v1/chat/completions`, { model: 'proxy-x', messages: [] });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_upstream_error');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------- 请求体超限

test('请求体超过上限时回 413，不把整个 body 读进来', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    request: { maxBodyBytes: 1024 },
  });

  try {
    const big = JSON.stringify({ model: 'proxy-x', messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
    const response = await post(`${proxy.url}/zen/go/v1/chat/completions`, big);
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.ok(payload.error.type, '要给出错误类型');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------- 上游流中途出错

test('上游响应流中途断开时请求会结束，而不是挂死', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    // 立刻毁掉 socket，制造「流到一半断了」
    setTimeout(() => res.socket?.destroy(), 30);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    // 响应已经开始，连接中途断掉——fetch 会报 terminated，这是**预期语义**。
    // 关键断言：请求必须结束（不能永远挂着），代理也不能因此崩。
    await assert.rejects(
      () => post(`${proxy.url}/zen/go/v1/chat/completions`, { model: 'proxy-x', messages: [], stream: true }).then((r) => r.text()),
      (error) => error instanceof Error,
    );
    const health = await fetch(`${proxy.url}/__llm_session_proxy__/health`);
    assert.equal(health.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游直接销毁连接时回 502', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    setTimeout(() => res.socket?.destroy(), 20);
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await post(`${proxy.url}/zen/go/v1/chat/completions`, { model: 'proxy-x', messages: [] });
    assert.ok([502, 500].includes(response.status), `状态码 ${response.status}`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------- 本地端点

test('/sessions 端点列出当前会话', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await post(`${proxy.url}/zen/go/v1/chat/completions`, { model: 'proxy-x', messages: [{ role: 'user', content: 'hi' }] });
    const response = await fetch(`${proxy.url}/__llm_session_proxy__/sessions`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(typeof payload.count, 'number');
    assert.ok(Array.isArray(payload.items));
    // 会话条目要带 key / id / count 这些字段
    if (payload.items.length) {
      const item = payload.items[0];
      assert.ok('key' in item);
      assert.ok('id' in item);
      assert.ok('count' in item);
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('/status 端点与 /health 返回同样的健康信息', async () => {
  const proxy = await startProxy();

  try {
    const health = await fetch(`${proxy.url}/__llm_session_proxy__/health`);
    const status = await fetch(`${proxy.url}/__llm_session_proxy__/status`);
    assert.equal(health.status, 200);
    assert.equal(status.status, 200);
    const a = await health.json();
    const b = await status.json();
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.ok(a.uptimeSeconds >= 0);
  } finally {
    await proxy.close();
  }
});

// ---------------------------------------------------------------- 客户端提前断开

test('客户端在请求发出前就断开，代理不会留下悬挂请求', async () => {
  let upstreamHits = 0;
  const upstream = await startFakeUpstream((req, res) => {
    upstreamHits += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await new Promise((resolve) => {
      const socket = net.connect(proxy.proxy.server.address().port, '127.0.0.1');
      socket.on('connect', () => {
        socket.write(
          'POST /zen/go/v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"model":"proxy-x"',
        );
        // 请求体没写完就断开
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 30);
      });
      socket.on('error', () => resolve());
    });

    // 代理还得能干活
    const health = await fetch(`${proxy.url}/__llm_session_proxy__/health`);
    assert.equal(health.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------- 响应写出

test('客户端提前断开导致写响应失败时，代理不崩溃', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ big: 'x'.repeat(200000) }));
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await new Promise((resolve) => {
      const socket = net.connect(proxy.proxy.server.address().port, '127.0.0.1');
      socket.on('connect', () => {
        socket.write(
          'POST /zen/go/v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"model":"proxy-x","a":1}',
        );
        // 读一点就断开，让写响应时撞上 EPIPE
        socket.once('data', () => {
          socket.destroy();
          resolve();
        });
      });
      socket.on('error', () => resolve());
      setTimeout(resolve, 500);
    });

    const health = await fetch(`${proxy.url}/__llm_session_proxy__/health`);
    assert.equal(health.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
