import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfig, DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { displayModel, parseModelSource, resolveSourceProvider } from '../src/model-prefix.js';

const SOURCE = { enabled: true, separator: ':', aliases: { gh: 'copilot', go: 'opencode-go' } };
const PROVIDERS = { copilot: {}, 'opencode-go': {}, openai: {} };
const PREFIXES = ['proxy-'];

test('parseModelSource: 默认关闭时原样返回', () => {
  const result = parseModelSource('copilot:gpt-5', { enabled: false }, PROVIDERS, PREFIXES);
  assert.equal(result.matched, false);
  assert.equal(result.model, 'copilot:gpt-5');
});

test('parseModelSource: copilot:gpt-5 与 proxy-copilot:gpt-5 都能拆出来源', () => {
  const a = parseModelSource('copilot:gpt-5', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(a.matched, true);
  assert.equal(a.source, 'copilot');
  assert.equal(a.model, 'gpt-5');
  const b = parseModelSource('proxy-copilot:gpt-5', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(b.matched, true);
  assert.equal(b.source, 'copilot');
  // 保留 proxy- 给 rewriteModel 按既有链剥离
  assert.equal(b.model, 'gpt-5');
});

test('parseModelSource: 别名短名映射到 provider 名', () => {
  const a = parseModelSource('gh:gpt-5', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(a.source, 'copilot');
  assert.equal(a.rawSource, 'gh');
  const b = parseModelSource('go:glm-5.3', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(b.source, 'opencode-go');
});

test('parseModelSource: 只认已配置的 provider / 别名，含冒号的模型名不误伤', () => {
  const unknown = parseModelSource('vendor:gpt-5', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(unknown.matched, false);
  assert.equal(unknown.model, 'vendor:gpt-5');
  const bare = parseModelSource('gpt-5', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(bare.matched, false);
  const empty = parseModelSource('copilot:', SOURCE, PROVIDERS, PREFIXES);
  assert.equal(empty.matched, false);
});

test('parseModelSource: 长 token 优先，避免 github 被 gh 截断', () => {
  const source = { enabled: true, separator: ':', aliases: { gh: 'copilot', github: 'openai' } };
  const result = parseModelSource('github:gpt-5', source, PROVIDERS, PREFIXES);
  assert.equal(result.source, 'openai');
});

test('parseModelSource: 自定义分隔符', () => {
  const source = { enabled: true, separator: '/', aliases: {} };
  const result = parseModelSource('copilot/gpt-5', source, PROVIDERS, PREFIXES);
  assert.equal(result.source, 'copilot');
  assert.equal(result.model, 'gpt-5');
});

test('displayModel: 加来源前缀且不重复加', () => {
  assert.equal(displayModel('copilot', 'gpt-5'), 'copilot:gpt-5');
  assert.equal(displayModel('copilot', 'copilot:gpt-5'), 'copilot:gpt-5');
  assert.equal(displayModel(null, 'gpt-5'), 'gpt-5');
  assert.equal(displayModel('copilot', ''), '');
});

test('resolveSourceProvider: 别名指向不存在的 provider 返回 null', () => {
  assert.equal(resolveSourceProvider('copilot', PROVIDERS), 'copilot');
  assert.equal(resolveSourceProvider('ghost', PROVIDERS), null);
  assert.equal(resolveSourceProvider(null, PROVIDERS), null);
});

test('config: sourcePrefix 默认关闭，开启后可被 buildConfig 接受', () => {
  assert.equal(DEFAULT_CONFIG.model.sourcePrefix.enabled, false);
  const config = buildConfig({ env: {}, flags: { model: { sourcePrefix: { enabled: true, aliases: { gh: 'copilot' } } } } });
  assert.equal(config.model.sourcePrefix.enabled, true);
  assert.equal(config.model.sourcePrefix.aliases.gh, 'copilot');
});

test('config: sourcePrefix 非法值启动即报错', () => {
  assert.throws(
    () => buildConfig({ env: {}, flags: { model: { sourcePrefix: { separator: '::' } } } }),
    /separator/,
  );
  assert.throws(
    () => buildConfig({ env: {}, flags: { model: { sourcePrefix: { aliases: [] } } } }),
    /aliases/,
  );
});

test('config: deepMerge 数组整体替换语义未被 sourcePrefix 改变', () => {
  const merged = deepMerge(DEFAULT_CONFIG, { model: { stripPrefixes: ['x-'] } });
  assert.deepEqual(merged.model.stripPrefixes, ['x-']);
});
