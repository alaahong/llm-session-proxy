import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildConfig, deepMerge } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { createProxyServer } from '../src/proxy.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('v0.4 本地端点与结构化日志端到端', async (t) => {
  const dir = tmpDir('lsp-observability-e2e-');
  const logFile = path.join(dir, 'proxy.log');
  const usageFile = path.join(dir, 'usage.jsonl');
  const upstream = await startUpstream();
  const exported = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('/otlp')) {
      exported.push({ url, init });
      return Promise.resolve({ ok: true, text: async () => '' });
    }
    return originalFetch(input, init);
  };

  const config = buildConfig({
    env: {},
    flags: {
      listen: { host: '127.0.0.1', port: 0 },
      log: { level: 'info', format: 'json' },
      usage: { file: usageFile },
      export: { enabled: true, endpoint: 'http://127.0.0.1:4318/otlp' },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    },
  });
  const logger = new Logger({ level: 'info', file: logFile, console: false, format: 'json', rotate: 'off' });
  const proxy = createProxyServer({ config, logger });
  await proxy.listen();
  const base = `http://127.0.0.1:${proxy.server.address().port}`;
  try {
    const proxied = await post(`${base}/v1/chat/completions`, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(proxied.status, 200);

    const metrics = await request(`${base}/__llm_session_proxy__/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers['content-type'], /text\/plain/);
    assert.match(metrics.body, /llm_session_proxy_requests_total 1/);
    assert.match(metrics.body, /llm_session_proxy_requests_by_status_total\{status="200"\} 1/);
    assert.match(metrics.body, /llm_session_proxy_prompt_tokens_total 10/);

    const dashboard = await request(`${base}/__llm_session_proxy__/dashboard`);
    assert.equal(dashboard.status, 200);
    assert.match(dashboard.headers['content-type'], /text\/html/);
    assert.match(dashboard.body, /local dashboard/);

    const prefix = await request(`${base}/__llm_session_proxy__/sessions/prefix`);
    assert.equal(prefix.status, 200);
    const inspector = JSON.parse(prefix.body);
    assert.ok(inspector.count >= 1);
    assert.ok(inspector.items.some((row) => row.requests >= 1));

    const wrongMethod = await request(`${base}/__llm_session_proxy__/metrics`, 'POST');
    assert.equal(wrongMethod.status, 405);

    const logs = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const requestRows = logs.filter((row) => row.event === 'request');
    assert.equal(requestRows.length, 1);
    assert.equal(requestRows[0].status, 200);
    assert.equal(requestRows[0].usage.totalTokens, 14);
    assert.ok(logs.every((row) => typeof row.ts === 'string' && typeof row.level === 'string'));
    assert.ok(!logs.some((row) => typeof row.message === 'string' && row.message.startsWith('[res]')));

    assert.equal(exported.length, 1);
    assert.equal(JSON.parse(exported[0].init.body).resourceLogs.length, 1);

    const usage = JSON.parse(fs.readFileSync(usageFile, 'utf8').trim().split('\n')[0]);
    assert.ok(usage.sessionId);
    assert.equal(usage.usage.totalTokens, 14);
  } finally {
    globalThis.fetch = originalFetch;
    await proxy.close();
    await upstream.close();
    for (const file of [logFile, usageFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(dir);
  }
  assert.ok(!t.skipped);
});

test('v0.4 关闭开关后 /metrics 与 /dashboard 返回 404', async () => {
  const upstream = await startUpstream();
  const config = buildConfig({
    env: {},
    flags: {
      listen: { host: '127.0.0.1', port: 0 },
      log: { level: 'silent' },
      metrics: { enabled: false },
      dashboard: { enabled: false },
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
    },
  });
  const logger = new Logger({ level: 'silent', console: false });
  const proxy = createProxyServer({ config, logger });
  await proxy.listen();
  const base = `http://127.0.0.1:${proxy.server.address().port}`;
  try {
    assert.equal((await request(`${base}/__llm_session_proxy__/metrics`)).status, 404);
    assert.equal((await request(`${base}/__llm_session_proxy__/dashboard`)).status, 404);
    assert.equal((await request(`${base}/__llm_session_proxy__/status`)).status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
