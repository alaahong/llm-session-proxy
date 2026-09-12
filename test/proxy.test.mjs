import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { createProxyServer } from '../src/proxy.js';

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

const chatBody = (message, extra = {}) => ({
  model: 'proxy-glm-5.3-flash',
  system: 'You are a helpful coding assistant.',
  messages: [{ role: 'user', content: message }],
  stream: true,
  ...extra,
});

test('注入会话头，同一对话内 session 稳定、请求号递增', async () => {
  const captured = [];
  const upstream = await startFakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw || '{}'), path: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const post = (messages) =>
      fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
        body: JSON.stringify({ ...chatBody('ignored'), messages }),
      }).then((r) => r.text());

    // 第二轮是同一对话的后续轮次：首条 user 消息不变，只在后面追加
    await post([{ role: 'user', content: '第一个问题' }]);
    await post([
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '第二个问题' },
    ]);

    assert.equal(captured.length, 2);
    const [first, second] = captured;

    assert.ok(first.headers['x-opencode-session'], '应当注入 x-opencode-session');
    assert.equal(
      first.headers['x-opencode-session'],
      second.headers['x-opencode-session'],
      '同一对话的会话 ID 必须稳定',
    );
    assert.equal(first.headers['x-opencode-request'], 'msg_1');
    assert.equal(second.headers['x-opencode-request'], 'msg_2');
    assert.equal(first.headers['x-opencode-client'], 'cli');
    assert.equal(first.headers['x-opencode-project'], 'global');
    assert.equal(first.headers['authorization'], 'Bearer test-key', '授权头必须原样透传');
    assert.match(first.headers['user-agent'], /^opencode\//, '通用 UA 应被替换成上游认识的 UA');
    assert.equal(first.path, '/zen/go/v1/chat/completions', '路径应当原样透传');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('模型别名剥离与 map 映射生效', async () => {
  const models = [];
  const upstream = await startFakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      models.push(JSON.parse(raw).model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    model: { map: { fast: 'glm-5.3-flash' } },
  });

  try {
    const send = (model) =>
      fetch(`${proxy.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      }).then((r) => r.text());

    await send('proxy-kimi-k3');
    await send('fast');
    await send('glm-5.2');

    assert.deepEqual(models, ['kimi-k3', 'glm-5.3-flash', 'glm-5.2']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('SSE 流式响应不被整体缓冲', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.write('data: second\n\n');
        res.end('data: [DONE]\n\n');
      }, 300);
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const started = Date.now();
    const response = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody('stream please')),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /event-stream/);

    let firstChunkAt = null;
    let text = '';
    for await (const chunk of response.body) {
      if (firstChunkAt === null) firstChunkAt = Date.now();
      text += Buffer.from(chunk).toString('utf8');
    }

    assert.ok(text.includes('data: first'));
    assert.ok(text.includes('data: [DONE]'));
    assert.ok(
      firstChunkAt - started < 250,
      `首块应在 250ms 内到达（实测 ${firstChunkAt - started}ms），说明没有被整体缓冲`,
    );
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游 4xx 错误体原样回传', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Request is missing x-opencode-session' } }));
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody('boom')),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error.message, /x-opencode-session/);
    assert.ok(response.headers.get('x-llm-session-proxy-session'), '响应应当带上会话调试头');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('pathRewrite 与 basePath 按配置改写路径，注入请求体字段也生效', async () => {
  const seen = [];
  const upstream = await startFakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port, basePath: '/zen/go/v1' },
    request: { pathRewrite: [{ pattern: '^/v1/', replacement: '/' }] },
    inject: { body: { metadata: { source: '{{session.id}}' }, temperature: 0.1 } },
  });

  try {
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [] }),
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/zen/go/v1/chat/completions');
    assert.equal(seen[0].body.temperature, 0.1);
    assert.match(seen[0].body.metadata.source, /^ses_[0-9a-f]{26}$/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('客户端自带会话头时优先使用它', async () => {
  const seen = [];
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers['x-opencode-session']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opencode-session': 'client-provided-session' },
      body: JSON.stringify(chatBody('hi')),
    });
    assert.deepEqual(seen, ['client-provided-session']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('本地状态端点返回运行信息', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.end('ok');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const status = await fetch(`${proxy.url}/__llm_session_proxy__/status`).then((r) => r.json());
    assert.equal(status.ok, true);
    assert.match(status.upstream, /127\.0\.0\.1/);
    assert.ok(Array.isArray(Object.keys(status.inject.headers)));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('上游不可达时返回 502 而不是崩溃', async () => {
  const proxy = await startProxy({
    // 指向一个几乎不可能有服务在听的端口
    upstream: { protocol: 'http', host: '127.0.0.1', port: 1 },
    request: { timeoutMs: 2000 },
  });

  try {
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.error.type, 'proxy_upstream_error');
  } finally {
    await proxy.close();
  }
});

test('别名剥完前缀仍无映射时告警，同一别名只喊一次，且可按配置关闭', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  /** 起一个把 warn 收集起来的代理：warn 是这里唯一关心的输出。 */
  const startCollecting = async (modelConfig) => {
    const warnings = [];
    const logger = {
      error: () => {},
      info: () => {},
      debug: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      close: () => {},
    };
    const config = deepMerge(DEFAULT_CONFIG, {
      listen: { host: '127.0.0.1', port: 0 },
      log: { level: 'silent' },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
      model: modelConfig,
    });
    const proxy = createProxyServer({ config, logger });
    await proxy.listen();
    return { proxy, warnings, url: `http://127.0.0.1:${proxy.server.address().port}` };
  };

  const send = (url, model) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    }).then((r) => r.text());

  try {
    const on = await startCollecting({ map: {}, warnUnmapped: true });
    await send(on.url, 'proxy-mystery');
    await send(on.url, 'proxy-mystery');
    await send(on.url, 'proxy-other');

    assert.equal(
      on.warnings.filter((line) => line.includes('proxy-mystery')).length,
      1,
      '同一个错别名被打多次，只该告警一次',
    );
    assert.equal(on.warnings.filter((line) => line.includes('proxy-other')).length, 1, '不同别名各喊一次');
    assert.ok(
      on.warnings.some((line) => line.startsWith('[model]')),
      `告警要沿用 ASCII 标签，便于 grep: ${on.warnings.join(' | ')}`,
    );
    assert.ok(
      on.warnings.some((line) => line.includes('mystery')),
      '告警要说清剥完前缀后实际发出去的名字',
    );
    await on.proxy.close();

    const off = await startCollecting({ map: {}, warnUnmapped: false });
    await send(off.url, 'proxy-mystery');
    assert.equal(off.warnings.length, 0, 'warnUnmapped=false 时不该告警');
    await off.proxy.close();

    const mapped = await startCollecting({ map: { known: 'real-model' } });
    await send(mapped.url, 'proxy-known');
    assert.equal(mapped.warnings.length, 0, '命中映射不该告警');
    await mapped.proxy.close();

    const realId = await startCollecting({ map: {} });
    await send(realId.url, 'glm-5.3');
    assert.equal(realId.warnings.length, 0, '客户端直接填真实 ID 属于正常透传，不该告警');
    await realId.proxy.close();
  } finally {
    await upstream.close();
  }
});
