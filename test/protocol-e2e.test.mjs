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
    url: `http://127.0.0.1:${proxy.server.address().port}`,
    close: async () => {
      await proxy.close();
      logger.close();
    },
  };
}

const chatRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ],
  max_tokens: 256,
  stream: false,
};

test('端到端：chat 请求被转成 messages 发上游，JSON 响应转回 chat', async () => {
  const captured = {};
  const upstream = await startFakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      captured.headers = req.headers;
      captured.body = JSON.parse(raw || '{}');
      captured.path = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'glm-5.3',
          content: [{ type: 'text', text: 'hello from anthropic' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      );
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: {
      enabled: true,
      paths: { chat: '/up/chat', messages: '/up/messages', responses: '/up/responses' },
      routes: [{ model: 'test-model', target: 'messages' }],
    },
  });

  try {
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatRequest),
    });
    const payload = await response.json();

    // 请求侧：路径换成目标协议的路径，体已经是 Anthropic 形状
    assert.equal(captured.path, '/up/messages', '上游路径应换成 protocol.paths.messages');
    assert.equal(captured.body.system, 'be brief', 'system 消息应归位到顶层');
    assert.equal(captured.body.max_tokens, 256);
    assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'hi' }]);
    assert.ok(!('messages' in captured.body && captured.body.messages[0].role === 'system'));
    assert.equal(captured.headers['accept-encoding'], 'identity', '必须强制明文，否则 SSE 没法解析');

    // 响应侧：Anthropic 的 JSON 转回了 chat.completion
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.choices[0].message.content, 'hello from anthropic');
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.equal(payload.usage.total_tokens, 14);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('端到端：上游的 chat SSE 流被转回 messages 事件，逐段写回客户端', async () => {
  // proxy 认定上游说 chat，所以假上游回 OpenAI 块；客户端说的是 Anthropic
  const upstreamSse = [
    `data: ${JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: ' streamed' }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ id: 'cmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 2 } }] })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');

  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(upstreamSse);
    res.end();
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'chat' },
  });

  try {
    // 客户端说的是 Anthropic（/v1/messages），--protocol chat 强制把上游当 OpenAI；
    // forced 的语义是「请求转成 chat 发上游、响应再转回 messages 给客户端」
    const anthropicRequest = {
      model: 'test-model',
      system: 'be brief',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    };
    const response = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicRequest),
    });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('content-length'), null, '转码后 content-length 不再有意义');
    const raw = await response.text();

    // 客户端收到的必须是 Anthropic 形状的事件序列
    assert.match(raw, /event: message_start/);
    assert.match(raw, /"type":"content_block_delta"/);
    assert.match(raw, /"text":" streamed"/);
    assert.match(raw, /"stop_reason":"end_turn"/);
    assert.match(raw, /event: message_stop/);
    assert.ok(!raw.includes('chat.completion.chunk'), '客户端不该看到 chat 形式的块');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('端到端：上游 4xx 错误体永不转写，原样回传', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    req.resume();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad thinking param' } }));
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    protocol: { enabled: true, forced: 'messages' },
  });

  try {
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatRequest),
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.type, 'error', '错误体保持上游原样，不转成 chat 的错误形状');
    assert.equal(payload.error.type, 'invalid_request_error');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('端到端：protocol 未启用时一切照旧（回归防线）', async () => {
  const captured = {};
  const upstream = await startFakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      captured.path = req.url;
      captured.body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"untouched":true}');
    });
  });
  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
  });

  try {
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatRequest),
    });
    const payload = await response.json();
    assert.equal(captured.path, '/v1/chat/completions', '路径原样透传');
    assert.equal(captured.body.messages[0].role, 'system', '请求体原样透传');
    assert.deepEqual(payload, { untouched: true });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
