import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  UsageStore,
  createResponseUsageProbe,
  createUsageProbe,
  entryCost,
  extractUsage,
  formatUsageLog,
  formatUsageReport,
  normalizeUsageTokens,
  readUsageReport,
  summarize,
  usageFilePath,
} from '../src/usage.js';
import { MESSAGE_KEYS, MESSAGES, setLang } from '../src/messages.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-usage-test-'));
}

test('normalizeUsageTokens: 三家协议的字段归一到同一组键', () => {
  assert.deepEqual(normalizeUsageTokens({ prompt_tokens: 10, completion_tokens: 5 }), {
    promptTokens: 10, completionTokens: 5, totalTokens: 15,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  });
  assert.equal(normalizeUsageTokens({ input_tokens: 20, output_tokens: 8, total_tokens: 100 }).totalTokens, 100);
  assert.equal(normalizeUsageTokens({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 }).totalTokens, 10);
  assert.equal(normalizeUsageTokens({}), null);
  assert.equal(normalizeUsageTokens(null), null);
});

test('extractUsage: chat / responses / messages / gemini 载荷', () => {
  assert.equal(extractUsage({ usage: { prompt_tokens: 4, completion_tokens: 2 } }).totalTokens, 6);
  assert.equal(extractUsage({ usage: { input_tokens: 4, output_tokens: 2 } }).promptTokens, 4);
  assert.equal(extractUsage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }).totalTokens, 6);
  assert.equal(extractUsage({ response: { usage: { input_tokens: 9, output_tokens: 3 } } }).totalTokens, 12);
  assert.equal(extractUsage({ message: { usage: { input_tokens: 3, output_tokens: 1 } } }).totalTokens, 4);
  assert.equal(extractUsage({ choices: [{ usage: { prompt_tokens: 2, completion_tokens: 1 } }] }).totalTokens, 3);
  assert.equal(extractUsage({ hello: 'world' }), null);
});

test('extractUsage: cache / reasoning 明细映射到统一字段', () => {
  const u = extractUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  });
  assert.equal(u.cacheReadTokens, 60);
  assert.equal(u.reasoningTokens, 5);
  const m = extractUsage({ usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 } });
  assert.equal(m.cacheReadTokens, 7);
  assert.equal(m.cacheWriteTokens, 2);
});

test('createUsageProbe: SSE 分块边界与最终 usage 覆盖', () => {
  const probe = createUsageProbe();
  const a = 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n';
  const b = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n';
  probe.push(Buffer.from(a.slice(0, 20)));
  probe.push(Buffer.from(a.slice(20) + b.slice(0, 15)));
  probe.push(Buffer.from(b.slice(15)));
  const usage = probe.end();
  assert.equal(usage.promptTokens, 10);
  assert.equal(usage.completionTokens, 3);
});

test('createUsageProbe: 坏 JSON 与 [DONE] 不抛错', () => {
  const probe = createUsageProbe();
  probe.push(Buffer.from('data: not-json\n\ndata: [DONE]\n\n'));
  assert.equal(probe.end(), null);
});

test('createResponseUsageProbe: SSE 与 JSON 各自走对路径', () => {
  const sse = createResponseUsageProbe('text/event-stream; charset=utf-8');
  sse.push(Buffer.from('data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n'));
  assert.equal(sse.end().totalTokens, 3);

  const json = createResponseUsageProbe('application/json');
  json.push(Buffer.from('{"ignored":'));
  json.push(Buffer.from('"x","usage":{"input_tokens":7,"output_tokens":4}}'));
  assert.equal(json.end().totalTokens, 11);

  const plain = createResponseUsageProbe('text/plain');
  plain.push(Buffer.from('not json at all'));
  assert.equal(plain.end(), null);
});

test('summarize: 按模型/来源分组并算效能与成本', () => {
  const entries = [
    { model: 'copilot:gpt-5', source: 'copilot', status: 200, durationMs: 1000, usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cacheReadTokens: 500 } },
    { model: 'copilot:gpt-5', source: 'copilot', status: 429, durationMs: 100, usage: null },
    { model: 'openai:gpt-5', source: 'openai', status: 500, durationMs: 500, usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 } },
  ];
  const prices = { 'copilot:gpt-5': { input: 2, output: 8, cacheRead: 0.5 } };
  const result = summarize(entries, { prices, currency: 'USD' });
  assert.equal(result.total.requests, 3);
  assert.equal(result.total.succeeded, 1);
  assert.equal(result.total.failed, 2);
  assert.equal(result.total.clientErrors, 1);
  assert.equal(result.total.serverErrors, 1);
  assert.equal(result.total.promptTokens, 1100);
  assert.equal(result.total.completionTokens, 200);
  assert.equal(result.total.cacheReadTokens, 500);
  assert.equal(result.byModel.length, 2);
  assert.equal(result.bySource.length, 2);
  assert.ok(result.total.completionTokensPerSecond > 0);
  assert.ok(result.total.avgDurationMs > 0);
  assert.ok(result.total.cost > 0);
  assert.equal(result.byModel[0].name, 'copilot:gpt-5');
  assert.equal(result.bySource[0].name, 'copilot');
});

test('entryCost: 价格表按 source:model > model > source > * 匹配，未配价为 0', () => {
  const prices = {
    '*': { input: 1, output: 1 },
    copilot: { input: 2, output: 4 },
    'gpt-5': { input: 3, output: 6 },
    'copilot:gpt-5': { input: 5, output: 10, cacheRead: 1 },
  };
  const make = (model, source) => ({ model, source, usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheReadTokens: 1_000_000 } });
  assert.equal(entryCost(make('gpt-5', 'copilot'), prices), 5 + 10 + 1);
  assert.equal(entryCost(make('gpt-5', 'openai'), prices), 3 + 6 + 3);
  assert.equal(entryCost(make('other', 'copilot'), prices), 2 + 4 + 2);
  assert.equal(entryCost(make('other', 'other'), prices), 3);
  assert.equal(entryCost(make('gpt-5', 'x'), {}), 0);
});

test('UsageStore: 落盘、重载与坏行跳过', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'usage.jsonl');
  const store = new UsageStore({ file });
  store.record({ model: 'a', source: 's', status: 200, durationMs: 10, usage: { prompt_tokens: 3, completion_tokens: 1 } });
  assert.ok(fs.existsSync(file));
  fs.appendFileSync(file, 'this is not json\n', 'utf8');
  store.record({ model: 'b', source: 's', status: 500, durationMs: 20, usage: null });
  const reloaded = new UsageStore({ file });
  // 第二条在坏行之后，仍能按行独立解析
  assert.equal(reloaded.entries.length, 2);
  assert.equal(reloaded.entries[0].model, 'a');
  assert.equal(reloaded.entries[1].model, 'b');
});

test('UsageStore: maxEntries 上限与轮转不抛错', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'usage.jsonl');
  const store = new UsageStore({ file, maxEntries: 3, maxBytes: 200 });
  for (let i = 0; i < 10; i += 1) {
    store.record({ model: `m${i}`, source: 's', status: 200, durationMs: i, usage: null });
  }
  assert.equal(store.entries.length, 3);
  assert.equal(store.entries[2].model, 'm9');
  assert.ok(store.dropped > 0);
  // 超阈值后原文件被轮转成 .1，正是预期行为
  assert.ok(fs.existsSync(`${file}.1`) || fs.existsSync(file));
});

test('formatUsageLog: ASCII 标签与关键字段', () => {
  const line = formatUsageLog({ model: 'copilot:gpt-5', source: 'copilot', status: 200, durationMs: 12, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
  assert.ok(line.startsWith('[usage]'));
  assert.ok(line.includes('model=copilot:gpt-5'));
  assert.ok(line.includes('in=5 out=2 total=7'));
  assert.ok(line.includes('ok=true'));
});

test('formatUsageReport: 中英都能排版、有价格/无价格分支', () => {
  const entries = [{ model: 'go:glm', source: 'go', status: 200, durationMs: 100, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }];
  const summary = summarize(entries, { prices: { 'go:glm': { input: 1, output: 2 } }, currency: 'USD' });
  setLang('en');
  const en = formatUsageReport(summary, { file: 'x.jsonl' });
  assert.ok(en.includes('Usage summary'));
  assert.ok(en.includes('BY MODEL'));
  assert.ok(en.includes('USD'));
  setLang('zh');
  const zh = formatUsageReport(summary, { file: 'x.jsonl' });
  assert.ok(zh.includes('用量汇总'));
  assert.ok(zh.includes('按模型'));
  setLang('en');
  const noPrice = formatUsageReport(summarize(entries), { file: 'x.jsonl' });
  assert.ok(noPrice.includes('No prices configured'));
});

test('readUsageReport: 指定文件离线读汇总', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'u.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ model: 'm', source: 's', status: 200, durationMs: 5, usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n`, 'utf8');
  const result = readUsageReport({ file, lang: 'en' });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('1 requests'));
  const missing = readUsageReport({ file: path.join(dir, 'missing.jsonl'), lang: 'en' });
  assert.equal(missing.ok, true);
  assert.ok(missing.text.includes('0 requests'));
});

test('usageFilePath: LSP_HOME 优先，默认 ~/.lsp', () => {
  assert.ok(usageFilePath({ LSP_HOME: '/tmp/lsp' }).endsWith(path.join('.lsp'.replace('.lsp', 'tmp/lsp'), 'usage.jsonl')) || usageFilePath({ LSP_HOME: '/tmp/lsp' }).includes('usage.jsonl'));
  assert.ok(usageFilePath({}, '/custom/u.jsonl').endsWith('u.jsonl'));
});

test('en / zh usage 文案 key 完全对应', () => {
  assert.deepEqual(MESSAGE_KEYS.filter((key) => key.startsWith('usage.')), Object.keys(MESSAGES.zh).filter((key) => key.startsWith('usage.')));
});
