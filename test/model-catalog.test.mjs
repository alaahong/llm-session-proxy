import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { setLang } from '../src/messages.js';
import {
  GO_MODELS_URL,
  MODEL_CACHE_TTL_MS,
  fetchGoModels,
  formatModelRow,
  loadPresetModels,
  mergeModelMap,
  modelCachePath,
  normalizeModels,
  readModelCache,
  renderCatalogComment,
  renderModelTable,
  writeModelCache,
} from '../src/model-catalog.js';

const samplePayload = {
  object: 'list',
  data: [
    {
      id: 'glm-5.3',
      name: 'GLM 5.3',
      family: 'glm',
      limit: { context: 1000000, output: 384000 },
      recommended_api: 'chat-completions',
      api: { 'chat-completions': {} },
      capabilities: { tools: { supported: true }, reasoning: { supported: false } },
      go: { zdr: true, monthly_usage: { go: 100 } },
    },
    {
      id: 'grok-4.7',
      name: 'Grok 4.7',
      limit: { context: 500000 },
      recommended_api: 'responses',
      api: { responses: {} },
      capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    },
    { id: 'glm-5.3', name: 'duplicate' },
    { name: 'no id' },
    null,
  ],
};

const fakeFetch = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test('normalizeModels 只收有效 id、去重、保留关键字段', () => {
  const { models } = normalizeModels(samplePayload, { fetchedAt: 1000 });
  assert.equal(models.length, 2);
  assert.deepEqual(models.map((m) => m.id), ['glm-5.3', 'grok-4.7']);
  assert.equal(models[0].context, 1000000);
  assert.equal(models[0].recommendedApi, 'chat-completions');
  assert.equal(models[0].tools, true);
  assert.equal(models[0].reasoning, false);
  assert.equal(models[0].zdr, true);
  assert.deepEqual(models[0].monthlyUsage, { go: 100 });
  assert.equal(models[1].recommendedApi, 'responses');
});

test('normalizeModels 遇到畸形响应返回空数组，不抛错', () => {
  assert.deepEqual(normalizeModels(null).models, []);
  assert.deepEqual(normalizeModels({ data: 'nope' }).models, []);
  assert.deepEqual(normalizeModels({ data: [1, 'x', {}] }).models, []);
});

test('fetchGoModels 成功时带 source=live 与 URL', async () => {
  const result = await fetchGoModels({ fetchImpl: fakeFetch(samplePayload) });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'live');
  assert.equal(result.url, GO_MODELS_URL);
  assert.equal(result.models.length, 2);
});

test('fetchGoModels 对 HTTP 错误与空清单都降级为 ok:false', async () => {
  const bad = await fetchGoModels({ fetchImpl: fakeFetch({}, 503) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /503/);
  const empty = await fetchGoModels({ fetchImpl: fakeFetch({ data: [] }) });
  assert.equal(empty.ok, false);
  assert.ok(empty.error);
});

test('fetchGoModels 遇到网络异常不抛错', async () => {
  const result = await fetchGoModels({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /offline/);
});

test('fetchGoModels 没有 fetch 实现时如实报错', async () => {
  const result = await fetchGoModels({ fetchImpl: null });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('缓存读写：路径在 LSP_HOME，TTL 内有效、过期返回 null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-models-'));
  const env = { LSP_HOME: home };
  assert.equal(modelCachePath(env), path.join(path.resolve(home), 'model-catalog.json'));
  const now = 5_000_000;
  const written = writeModelCache({ fetchedAt: now, models: samplePayload.data.slice(0, 1), url: GO_MODELS_URL }, env);
  assert.ok(fs.existsSync(written));
  assert.ok(readModelCache(env, now + 1000));
  assert.equal(readModelCache(env, now + MODEL_CACHE_TTL_MS + 1), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('缓存文件损坏时返回 null，不抛错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-models-'));
  fs.writeFileSync(path.join(home, 'model-catalog.json'), 'not json', 'utf8');
  assert.equal(readModelCache({ LSP_HOME: home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('实时失败时回落到未过期缓存并标记 stale', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-models-'));
  const env = { LSP_HOME: home };
  const now = 5_000_000;
  writeModelCache({ fetchedAt: now, models: samplePayload.data.slice(0, 1) }, env);
  const result = await loadPresetModels({
    preset: 'opencode-go',
    env,
    now: now + 1000,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'cache');
  assert.equal(result.stale, true);
  assert.match(result.refreshError, /offline/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Copilot 预设如实返回无公开端点，不编造数据', async () => {
  const result = await loadPresetModels({ preset: 'copilot' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-public-endpoint');
  assert.deepEqual(result.models, []);
});

test('未知预设返回 unknown-preset', async () => {
  const result = await loadPresetModels({ preset: 'nope' });
  assert.equal(result.reason, 'unknown-preset');
});

test('renderModelTable 含表头，limit 生效，展示推荐 API', () => {
  const { models } = normalizeModels(samplePayload);
  const all = renderModelTable(models);
  assert.match(all, /MODEL ID/);
  assert.match(all, /grok-4\.7/);
  assert.match(all, /responses/);
  const one = renderModelTable(models, { limit: 1 });
  assert.equal(one.split('\n').length, 2);
  assert.match(formatModelRow(models[0]), /1000k/);
});

test('mergeModelMap 保留用户短别名，只补官方完整 id', () => {
  const merged = mergeModelMap({ glm: 'glm-5.3', custom: 'my-model' }, normalizeModels(samplePayload).models);
  assert.equal(merged.glm, 'glm-5.3');
  assert.equal(merged.custom, 'my-model');
  assert.equal(merged['glm-5.3'], 'glm-5.3');
  assert.equal(merged['grok-4.7'], 'grok-4.7');
});

test('renderCatalogComment 容忍 null / 失败结果（--no-models 与 copilot 路径）', () => {
  assert.deepEqual(renderCatalogComment(null), []);
  assert.deepEqual(renderCatalogComment({ ok: false, models: [] }), []);
  assert.deepEqual(renderCatalogComment({ ok: true, models: null }), []);
  const lines = renderCatalogComment({ ok: true, source: 'live', fetchedAt: 1000, models: normalizeModels(samplePayload).models, url: GO_MODELS_URL });
  assert.ok(lines.some((l) => /available models \(2\)/.test(l)));
  assert.ok(lines.some((l) => /grok-4\.7  \[responses\]/.test(l)));
});

test('en / zh 的模型清单文案 key 对应', async () => {
  const { MESSAGES } = await import('../src/messages.js');
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
  setLang('en');
  assert.ok(MESSAGE_HAS(MESSAGES.en, 'models.err.copilotNoEndpoint'));
});

function MESSAGE_HAS(bucket, key) {
  return typeof bucket[key] === 'function';
}
