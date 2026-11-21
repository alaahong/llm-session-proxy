import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildConfig, DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { renderDashboard } from '../src/dashboard.js';
import { createExporter, renderOtlpJson } from '../src/export.js';
import { Logger } from '../src/logger.js';
import { setLang } from '../src/messages.js';
import { inspectSessionPrefixes, MetricsCollector } from '../src/metrics.js';
import { formatUsageReport, summarize } from '../src/usage.js';
import { parseArgv } from '../src/cli.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Logger: json 模式一行一个 JSON 对象，字段名与语言无关', () => {
  const dir = tmpDir('lsp-jsonlog-');
  const file = path.join(dir, 'log.jsonl');
  try {
    const logger = new Logger({ level: 'info', file, console: false, format: 'json', rotate: 'off' });
    logger.info({ event: 'custom', value: 7 });
    logger.text('info', '[res] 200 4B 12ms');
    logger.structured('info', { event: 'request', status: 200 });
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].level, 'info');
    assert.equal(rows[0].event, 'custom');
    assert.equal(rows[0].value, 7);
    assert.match(rows[0].ts, /^\d{4}-\d\d-\d\dT/);
    assert.equal(rows[1].event, 'request');
    assert.equal(rows[1].status, 200);
    assert.ok(!('message' in rows[1]));
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('Logger: text 模式下 structured() 不输出，避免一个请求两行', () => {
  const dir = tmpDir('lsp-textlog-');
  const file = path.join(dir, 'log.txt');
  try {
    const logger = new Logger({ level: 'info', file, console: false, format: 'text', rotate: 'off' });
    logger.structured('info', { event: 'request', status: 200 });
    logger.text('info', '[res] 200');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[res\] 200/);
    assert.ok(!text.includes('request'));
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test('MetricsCollector: 计数、标签转义、直方图与会话快照', () => {
  const collector = new MetricsCollector({
    startedAt: Date.now() - 5000,
    getSessions: () => ({ active: 2, hits: 3, misses: 1 }),
  });
  collector.observe({
    status: 200, upstream: 'co"pilot', source: 'copilot', durationMs: 12,
    bytesIn: 100, bytesOut: 200,
    usage: { promptTokens: 10, cacheReadTokens: 5, completionTokens: 8 },
  });
  collector.observe({ status: 502, error: 'transport', upstream: 'x', durationMs: 1000 });
  const text = collector.render();
  assert.match(text, /llm_session_proxy_requests_total 2/);
  assert.match(text, /llm_session_proxy_requests_by_status_total\{status="200"\} 1/);
  assert.match(text, /llm_session_proxy_requests_by_status_total\{status="502"\} 1/);
  assert.match(text, /llm_session_proxy_requests_by_upstream_total\{upstream="co\\"pilot"\} 1/);
  assert.match(text, /llm_session_proxy_failures_total\{reason="transport"\} 1/);
  assert.match(text, /llm_session_proxy_bytes_in_total 100/);
  assert.match(text, /llm_session_proxy_bytes_out_total 200/);
  assert.match(text, /llm_session_proxy_request_duration_seconds_bucket\{le="0\.025"\} 1/);
  assert.match(text, /llm_session_proxy_request_duration_seconds_bucket\{le="\+Inf"\} 2/);
  assert.match(text, /llm_session_proxy_sessions_active 2/);
  assert.match(text, /llm_session_proxy_sessions_hits_total 3/);
  assert.match(text, /llm_session_proxy_prompt_cache_reuse_ratio 0\.333333/);
});

test('inspectSessionPrefixes: 从会话表与用量记录拼出前缀哈希与复用估算', () => {
  const store = {
    map: new Map([
      ['k_abc', { id: 'ses_1', count: 3, createdAt: 1, lastUsed: 2 }],
      ['explicit:x', { id: 'ses_2', count: 1, createdAt: 1, lastUsed: 2 }],
    ]),
  };
  const entries = [
    { sessionId: 'ses_1', sessionKey: 'k_abc', usage: { promptTokens: 100, cacheReadTokens: 50 } },
    { sessionId: 'ses_1', sessionKey: 'k_abc', usage: { promptTokens: 100, cacheReadTokens: 50 } },
  ];
  const result = inspectSessionPrefixes({ store, entries });
  assert.equal(result.count, 2);
  const first = result.items[0];
  assert.equal(first.sessionId, 'ses_1');
  assert.equal(first.prefixHash, 'k_abc');
  assert.equal(first.requests, 2);
  assert.equal(first.cacheReadRate, 0.3333);
  assert.equal(first.cacheReusable, 'likely');
  assert.equal(result.items.find((x) => x.sessionId === 'ses_2').prefixHash, null);
});

test('OTLP/JSON: 渲染结构与导出开关、计数', async () => {
  const payload = renderOtlpJson({ ts: '2026-01-01T00:00:00.000Z', status: 200, event: 'request', model: 'copilot:gpt-5' });
  const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(payload.resourceLogs[0].resource.attributes[0].value.stringValue, 'llm-session-proxy');
  assert.equal(record.body.stringValue, 'llm-session-proxy request');
  assert.equal(record.severityText, 'INFO');
  assert.ok(record.attributes.some((a) => a.key === 'model'));

  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => '' };
  };
  const exporter = createExporter({ enabled: true, endpoint: 'http://127.0.0.1:9/otlp', headers: { 'x-test': '1' }, fetchImpl: fakeFetch });
  assert.equal(exporter.enabled, true);
  const ok = await exporter.export({ event: 'request', status: 200 });
  assert.equal(ok, true);
  assert.equal(exporter.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-test'], '1');
  assert.equal(JSON.parse(calls[0].options.body).resourceLogs.length, 1);

  const off = createExporter({ enabled: false, endpoint: 'http://127.0.0.1:9/otlp', fetchImpl: fakeFetch });
  assert.equal(await off.export({}), false);
  assert.equal(calls.length, 1);

  const failing = createExporter({ enabled: true, endpoint: 'http://127.0.0.1:9/otlp', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await failing.export({}), false);
  assert.equal(failing.dropped, 1);
});

test('Usage: 按会话聚合与报表新增字段', () => {
  const previous = 'en';
  try {
    setLang('en');
    const summary = summarize([
      { model: 'copilot:gpt-5', source: 'copilot', sessionId: 'ses_a', sessionKey: 'k_1', status: 200, durationMs: 100, usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, cacheWriteTokens: 7, reasoningTokens: 3 } },
      { model: 'copilot:gpt-5', source: 'copilot', sessionId: 'ses_b', sessionKey: 'explicit:x', status: 200, durationMs: 200, usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
    ]);
    assert.equal(summary.bySession.length, 2);
    assert.equal(summary.bySession[0].name, 'ses_a');
    assert.equal(summary.bySession[0].key, 'k_1');
    assert.equal(summary.total.cacheWriteTokens, 7);
    assert.equal(summary.total.reasoningTokens, 3);
    const text = formatUsageReport(summary, { file: 'usage.jsonl' });
    assert.match(text, /BY SESSION/);
    assert.match(text, /cache-write/);
    assert.match(text, /reasoning/);
  } finally {
    setLang(previous);
  }
});

test('Dashboard: 单文件 HTML 自带样式/脚本，且只访问本地端点', () => {
  const html = renderDashboard();
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /var P="\/__llm_session_proxy__"/);
  assert.match(html, /text\('\/metrics'\)/);
  assert.match(html, /get\('\/sessions\/prefix'\)/);
  assert.ok(!html.includes('<script src='));
  assert.ok(!html.includes('<link rel="stylesheet"'));
  assert.ok(!html.includes('https://cdn'));
});

test('Config/CLI: log.format、metrics/dashboard/export 开关与校验', () => {
  const parsed = parseArgv(['--log-format', 'json', '--no-metrics', '--no-dashboard', '--export-endpoint', 'http://127.0.0.1:4318/otlp']);
  assert.equal(parsed.flags.log.format, 'json');
  assert.equal(parsed.flags.metrics.enabled, false);
  assert.equal(parsed.flags.dashboard.enabled, false);
  assert.equal(parsed.flags.export.enabled, true);
  assert.equal(parsed.flags.export.endpoint, 'http://127.0.0.1:4318/otlp');

  const cfg = buildConfig({ flags: deepMerge({}, parsed.flags), env: {} });
  assert.equal(cfg.log.format, 'json');
  assert.equal(cfg.metrics.enabled, false);
  assert.equal(cfg.export.enabled, true);

  assert.throws(
    () => buildConfig({ flags: { log: { format: 'xml' } }, env: {} }),
    /log\.format/,
  );
  assert.throws(
    () => buildConfig({ flags: { export: { endpoint: 'file:///tmp/x' } }, env: {} }),
    /export\.endpoint/,
  );
  assert.equal(DEFAULT_CONFIG.metrics.enabled, true);
  assert.equal(DEFAULT_CONFIG.export.enabled, false);
});
