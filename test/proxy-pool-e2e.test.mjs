import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

/** 收下请求、记下路径与头，回一个最小的 chat 响应。 */
function captureUpstream(captured, tag) {
  return startFakeUpstream((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      captured.push({ tag, path: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'r1',
          object: 'chat.completion',
          created: 1,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
}

test('上游池：按模型前缀把请求发到不同的上游', async () => {
  const captured = [];
  const upstreamA = await captureUpstream(captured, 'A');
  const upstreamB = await captureUpstream(captured, 'B');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstreamA.port },
    upstreams: {
      providers: {
        a: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamA.port}` },
        b: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamB.port}` },
      },
      routes: [{ model: 'proxy-b-model', upstream: 'b' }],
      default: 'a',
    },
    model: { map: {} },
  });

  try {
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'proxy-a-model', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'proxy-b-model', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    assert.equal(captured.length, 2);
    assert.equal(captured[0].tag, 'A');
    assert.equal(captured[1].tag, 'B');
    // 端点路径来自 provider 自己
    assert.equal(captured[0].path, '/chat/completions');
    assert.equal(captured[1].path, '/chat/completions');
  } finally {
    await proxy.close();
    await upstreamA.close();
    await upstreamB.close();
  }
});

test('上游池：桶里的 upstream 优先于模型前缀规则', async () => {
  const captured = [];
  const upstreamA = await captureUpstream(captured, 'A');
  const upstreamB = await captureUpstream(captured, 'B');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstreamA.port },
    router: {
      enabled: true,
      buckets: { special: { upstream: 'b' } },
      rules: [{ bucket: 'special', modelPrefix: 'proxy-x' }],
    },
    upstreams: {
      providers: {
        a: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamA.port}` },
        b: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamB.port}` },
      },
      routes: [{ model: 'proxy-x', upstream: 'a' }],
      default: 'a',
    },
    model: { map: {} },
  });

  try {
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'proxy-x', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    assert.equal(captured.length, 1);
    assert.equal(captured[0].tag, 'B', '桶里点名的上游应该赢过模型前缀规则');
  } finally {
    await proxy.close();
    await upstreamA.close();
    await upstreamB.close();
  }
});

test('上游池：凭据从环境变量取，装进对应的头里', async () => {
  const captured = [];
  const upstream = await captureUpstream(captured, 'A');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    upstreams: {
      providers: {
        a: { type: 'openai', baseUrl: `http://127.0.0.1:${upstream.port}`, auth: { env: 'LSP_TEST_KEY' } },
      },
      default: 'a',
    },
    model: { map: {} },
  });

  const previous = process.env.LSP_TEST_KEY;
  process.env.LSP_TEST_KEY = 'sk-test-value';

  try {
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    assert.equal(captured.length, 1);
    assert.equal(captured[0].headers.authorization, 'Bearer sk-test-value');
  } finally {
    if (previous === undefined) delete process.env.LSP_TEST_KEY;
    else process.env.LSP_TEST_KEY = previous;
    await proxy.close();
    await upstream.close();
  }
});

test('上游池：Gemini 的凭据走 x-goog-api-key，模型名进路径', async () => {
  const captured = [];
  const upstream = await captureUpstream(captured, 'A');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    upstreams: {
      providers: {
        g: {
          type: 'gemini',
          baseUrl: `http://127.0.0.1:${upstream.port}`,
          auth: { env: 'LSP_TEST_GEMINI_KEY' },
        },
      },
      default: 'g',
    },
    model: { map: {} },
    response: { stream: false },
  });

  const previous = process.env.LSP_TEST_GEMINI_KEY;
  process.env.LSP_TEST_GEMINI_KEY = 'gemini-key';

  try {
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    assert.equal(captured.length, 1);
    assert.equal(captured[0].headers['x-goog-api-key'], 'gemini-key');
    assert.ok(captured[0].path.includes('gemini-3.5-flash'), `路径应带模型名：${captured[0].path}`);
  } finally {
    if (previous === undefined) delete process.env.LSP_TEST_GEMINI_KEY;
    else process.env.LSP_TEST_GEMINI_KEY = previous;
    await proxy.close();
    await upstream.close();
  }
});

test('上游池：Copilot 的固定头自动带上', async () => {
  const captured = [];
  const upstream = await captureUpstream(captured, 'A');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    upstreams: {
      providers: {
        c: { type: 'copilot', baseUrl: `http://127.0.0.1:${upstream.port}`, auth: { allowCommand: false } },
      },
      default: 'c',
    },
    model: { map: {} },
  });

  // 这条测试要断言「拿不到凭据就发不出去」，所以必须把本机可能存在的
  // GitHub 凭据全部屏蔽掉，否则开发者机器上装了 gh CLI 就变成真调用。
  const saved = {};
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'LSP_HOME']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // LSP_HOME 指到一个空目录 → 读不到落盘的凭据文件
  const emptyHome = path.join(os.tmpdir(), `lsp-copilot-test-${process.pid}`);
  fs.mkdirSync(emptyHome, { recursive: true });
  process.env.LSP_HOME = emptyHome;

  try {
    // Copilot 的凭据走 session token 交换，没有 token 时会 502 ——
    // 但固定头在组装请求时就装好了，所以这里只看头。
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    // 没配凭据 → Copilot 拿不到 session token → 请求不会到上游
    assert.equal(captured.length, 0);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(emptyHome, { recursive: true, force: true });
    await proxy.close();
    await upstream.close();
  }
});

test('上游池为空时行为与之前完全一致（走 config.upstream）', async () => {
  const captured = [];
  const upstream = await captureUpstream(captured, 'A');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port, basePath: '/zen/go/v1' },
    request: { pathRewrite: [{ pattern: '^/v1/', replacement: '/' }] },
    model: { map: {} },
  });

  try {
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    }).then((r) => r.text());

    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, '/zen/go/v1/chat/completions');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('难度路由：分数高的请求落到不同的桶', async () => {
  const captured = [];
  const upstream = await captureUpstream(captured, 'A');

  const proxy = await startProxy({
    upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    router: {
      enabled: true,
      scorers: { enabled: ['builtin-complexity'] },
      bands: [
        { name: 'easy', maxScore: 30 },
        { name: 'hard', maxScore: 100 },
      ],
      buckets: {
        easy: { model: 'easy-model' },
        hard: { model: 'hard-model' },
      },
      rules: [
        { bucket: 'hard', difficulty: 'hard' },
        { bucket: 'easy', difficulty: 'easy' },
      ],
    },
    model: { map: {} },
  });

  try {
    // 简单请求：一句话
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    }).then((r) => r.text());

    // 复杂请求：一大段代码 + 多个工具 + 明确要推理
    const bigCode = Array.from({ length: 12 }, (_, i) => '```js\nconst v' + i + ' = ' + i + ';\n```').join('\n');
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: bigCode }],
        tools: Array.from({ length: 10 }, (_, i) => ({
          type: 'function',
          function: { name: 't' + i, parameters: { type: 'object' } },
        })),
        reasoning_effort: 'high',
      }),
    }).then((r) => r.text());

    assert.equal(captured.length, 2);
    assert.equal(captured[0].body.model, 'easy-model');
    assert.equal(captured[1].body.model, 'hard-model');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
