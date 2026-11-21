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

function makeConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, {
    listen: { host: '127.0.0.1', port: 0 },
    log: { level: 'silent' },
    ...overrides,
  });
}

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10000),
});

test('usage: JSON 响应的 token 被旁路采集并落盘，记录按请求写日志', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-usage-e2e-'));
  const file = path.join(dir, 'usage.jsonl');
  const logFile = path.join(dir, 'proxy.log');
  const upstream = await startFakeUpstream((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', model: JSON.parse(body).model,
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 4 } },
      }));
    });
  });
  const logger = new Logger({ level: 'debug', console: false, file: logFile });
  const proxy = createProxyServer({
    config: makeConfig({
      usage: { file, logEachRequest: true },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    }),
    logger,
  });
  await proxy.listen();
  const url = `http://127.0.0.1:${proxy.server.address().port}/zen/go/v1/chat/completions`;
  try {
    const response = await post(url, { model: 'proxy-glm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 200);
    // 等 end 事件把用量写完
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(proxy.usage.entries.length, 1);
    const entry = proxy.usage.entries[0];
    assert.equal(entry.status, 200);
    assert.equal(entry.usage.promptTokens, 12);
    assert.equal(entry.usage.completionTokens, 5);
    assert.equal(entry.usage.cacheReadTokens, 4);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('"promptTokens":12'));
    const log = fs.readFileSync(logFile, 'utf8');
    assert.ok(log.includes('[usage]'));
    assert.ok(log.includes('in=12 out=5 total=17'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('usage: SSE 末块 usage 也能采集，4xx 记为失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-usage-e2e-'));
  const file = path.join(dir, 'usage.jsonl');
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const logger = new Logger({ level: 'silent', console: false });
  const proxy = createProxyServer({
    config: makeConfig({
      usage: { file },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    }),
    logger,
  });
  await proxy.listen();
  try {
    const url = `http://127.0.0.1:${proxy.server.address().port}/zen/go/v1/chat/completions`;
    const response = await post(url, { model: 'proxy-glm', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(response.status, 200);
    await response.text();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(proxy.usage.entries.length, 1);
    assert.equal(proxy.usage.entries[0].usage.totalTokens, 12);
  } finally {
    await proxy.close();
    await upstream.close();
  }

  // 4xx：换一个回 429 的上游
  const errUpstream = await startFakeUpstream((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate limited' }));
  });
  const errLogger = new Logger({ level: 'silent', console: false });
  const errProxy = createProxyServer({
    config: makeConfig({
      usage: { file },
      upstream: { protocol: 'http', host: '127.0.0.1', port: errUpstream.port },
    }),
    logger: errLogger,
  });
  await errProxy.listen();
  try {
    const url = `http://127.0.0.1:${errProxy.server.address().port}/zen/go/v1/chat/completions`;
    const response = await post(url, { model: 'proxy-glm', messages: [] });
    assert.equal(response.status, 429);
    await new Promise((r) => setTimeout(r, 200));
    const last = errProxy.usage.entries.at(-1);
    assert.equal(last.status, 429);
    assert.equal(last.ok, false);
    assert.ok(last.error.includes('429'));
  } finally {
    await errProxy.close();
    await errUpstream.close();
  }
});

test('usage: enabled=false 时不建 store，不写文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-usage-e2e-'));
  const file = path.join(dir, 'usage.jsonl');
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const proxy = createProxyServer({
    config: makeConfig({
      usage: { enabled: false, file },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    }),
    logger: new Logger({ level: 'silent', console: false }),
  });
  await proxy.listen();
  try {
    assert.equal(proxy.usage, null);
    const url = `http://127.0.0.1:${proxy.server.address().port}/zen/go/v1/chat/completions`;
    await post(url, { model: 'proxy-glm', messages: [] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(file), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('source prefix: copilot:gpt-5 强制走 copilot 上游，模型名剥前缀后转发', async () => {
  const seen = [];
  const makeUpstream = (name) => startFakeUpstream((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ name, url: req.url, model: JSON.parse(body).model });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echo: name }));
    });
  });
  const copilot = await makeUpstream('copilot');
  const other = await makeUpstream('other');
  const proxy = createProxyServer({
    config: makeConfig({
      model: { sourcePrefix: { enabled: true } },
      upstreams: {
        enabled: true,
        providers: {
          copilot: { type: 'custom', baseUrl: `http://127.0.0.1:${copilot.port}`, paths: { chat: '/chat/completions' } },
          other: { type: 'custom', baseUrl: `http://127.0.0.1:${other.port}`, paths: { chat: '/chat/completions' } },
        },
        routes: [{ model: 'x', upstream: 'other' }],
        default: 'other',
      },
      usage: { enabled: false },
    }),
    logger: new Logger({ level: 'silent', console: false }),
  });
  await proxy.listen();
  try {
    const url = `http://127.0.0.1:${proxy.server.address().port}/chat/completions`;
    const response = await post(url, { model: 'copilot:gpt-5', messages: [] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).echo, 'copilot');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].model, 'gpt-5');
    // 来源前缀优先级高于 default 与 routes
    assert.equal(seen[0].name, 'copilot');
  } finally {
    await proxy.close();
    await copilot.close();
    await other.close();
  }
});

test('source prefix: 未知来源告警并回退常规路由，不 500', async () => {
  const seen = [];
  const upstream = await startFakeUpstream((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push(JSON.parse(body).model);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const proxy = createProxyServer({
    config: makeConfig({
      model: { sourcePrefix: { enabled: true } },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
      upstreams: { enabled: true, providers: {}, default: null },
      usage: { enabled: false },
    }),
    logger: new Logger({ level: 'silent', console: false }),
  });
  await proxy.listen();
  try {
    const url = `http://127.0.0.1:${proxy.server.address().port}/chat/completions`;
    const response = await post(url, { model: 'ghost:gpt-5', messages: [] });
    assert.equal(response.status, 200);
    assert.equal(seen[0], 'ghost:gpt-5');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
