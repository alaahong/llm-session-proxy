import assert from 'node:assert/strict';
import test from 'node:test';

import { applyBodyInject, buildInjectHeaders, rewriteModel, rewritePath } from '../src/inject.js';
import { createContext } from '../src/template.js';

const modelConfig = (overrides = {}) => ({
  enabled: true,
  field: 'model',
  stripPrefixes: ['proxy-'],
  map: {},
  default: null,
  ...overrides,
});

test('rewriteModel 剥掉前缀并写回请求体', () => {
  const body = { model: 'proxy-glm-5.3-flash' };
  const result = rewriteModel(body, modelConfig());

  assert.equal(result.changed, true);
  assert.equal(result.from, 'proxy-glm-5.3-flash');
  assert.equal(result.to, 'glm-5.3-flash');
  assert.equal(body.model, 'glm-5.3-flash');
});

test('rewriteModel 的 map 优先于前缀剥离', () => {
  const body = { model: 'proxy-fast' };
  const result = rewriteModel(body, modelConfig({ map: { 'proxy-fast': 'deepseek-chat' } }));

  assert.equal(result.changed, true);
  assert.equal(body.model, 'deepseek-chat', 'map 命中后不应再剥前缀');
});

test('rewriteModel 剥掉前缀后仍能命中 map 里的短别名', () => {
  const body = { model: 'proxy-fast' };
  const result = rewriteModel(body, modelConfig({ map: { fast: 'glm-5.3-flash' } }));

  assert.equal(result.changed, true);
  assert.equal(body.model, 'glm-5.3-flash', '先剥前缀再查 map，两种写法可以叠加');
});

test('rewriteModel 的原始名映射依然优先于前缀剥离', () => {
  const body = { model: 'proxy-fast' };
  rewriteModel(body, modelConfig({ map: { 'proxy-fast': 'direct-wins', fast: 'indirect' } }));

  assert.equal(body.model, 'direct-wins');
});

test('rewriteModel 前缀不匹配时保持不变', () => {
  const body = { model: 'glm-5.2' };
  const result = rewriteModel(body, modelConfig());

  assert.equal(result.changed, false);
  assert.equal(body.model, 'glm-5.2');
});

test('rewriteModel 在没有前缀规则时用 default 兜底', () => {
  const body = { model: 'unknown-model' };
  const result = rewriteModel(body, modelConfig({ stripPrefixes: [], default: 'glm-5.3' }));

  assert.equal(result.changed, true);
  assert.equal(body.model, 'glm-5.3');
});

test('rewriteModel 对关闭开关、非字符串模型名、非对象请求体都不动作', () => {
  const body1 = { model: 'proxy-x' };
  assert.equal(rewriteModel(body1, modelConfig({ enabled: false })).changed, false);
  assert.equal(body1.model, 'proxy-x');

  const body2 = { model: 123 };
  assert.equal(rewriteModel(body2, modelConfig()).changed, false);
  assert.equal(body2.model, 123);

  assert.equal(rewriteModel(null, modelConfig()).changed, false);
  assert.equal(rewriteModel({}, modelConfig()).changed, false);
});

test('rewriteModel 支持自定义模型字段名', () => {
  const body = { model_id: 'proxy-glm-5.3' };
  const result = rewriteModel(body, modelConfig({ field: 'model_id' }));

  assert.equal(result.changed, true);
  assert.equal(body.model_id, 'glm-5.3');
});

test('rewritePath 按顺序应用多条规则', () => {
  const rules = [
    { pattern: '^/v1/', replacement: '/zen/go/v1/' },
    { pattern: '/responses$', replacement: '/chat/completions' },
  ];

  assert.equal(rewritePath('/v1/responses', rules), '/zen/go/v1/chat/completions');
  assert.equal(rewritePath('/zen/go/v1/messages', rules), '/zen/go/v1/messages');
  assert.equal(rewritePath('/other', rules), '/other');
});

test('rewritePath 支持 flags，无规则时原样返回', () => {
  assert.equal(rewritePath('/API/x', [{ pattern: '/api/', replacement: '/v1/', flags: 'i' }]), '/v1/x');
  assert.equal(rewritePath('/a/b', []), '/a/b');
  assert.equal(rewritePath('/a/b'), '/a/b');
});

test('applyBodyInject 合并嵌套字段并渲染模板', () => {
  const ctx = createContext({ session: { id: 'ses_test' } });
  const body = { temperature: 0.1 };

  const result = applyBodyInject(
    body,
    { body: { top_p: 0.9, metadata: { source: '{{session.id}}' } }, removeBodyFields: [], overwrite: true },
    ctx,
  );

  assert.equal(result.changed, true);
  assert.equal(body.temperature, 0.1, '原有字段应当保留');
  assert.equal(body.top_p, 0.9);
  assert.equal(body.metadata.source, 'ses_test');
});

test('applyBodyInject 在 overwrite=false 时不覆盖客户端已有字段', () => {
  const ctx = createContext();
  const body = { temperature: 0.1 };

  applyBodyInject(body, { body: { temperature: 0.9, top_p: 0.5 }, overwrite: false }, ctx);

  assert.equal(body.temperature, 0.1);
  assert.equal(body.top_p, 0.5);
});

test('applyBodyInject 的 removeBodyFields 支持点路径', () => {
  const ctx = createContext();
  const body = {
    metadata: { trace: 'x', keep: 'y' },
    stream_options: { include_usage: true },
    messages: [],
  };

  const result = applyBodyInject(
    body,
    { body: {}, removeBodyFields: ['metadata.trace', 'stream_options'], overwrite: true },
    ctx,
  );

  assert.equal(result.changed, true);
  assert.equal(body.metadata.trace, undefined);
  assert.equal(body.metadata.keep, 'y');
  assert.equal(body.stream_options, undefined);
  assert.deepEqual(body.messages, []);
});

test('applyBodyInject 对空配置或非对象请求体报告未变化', () => {
  const ctx = createContext();
  assert.equal(applyBodyInject({ a: 1 }, { body: {}, removeBodyFields: [] }, ctx).changed, false);
  assert.equal(applyBodyInject({ a: 1 }, {}, ctx).changed, false);
  assert.equal(applyBodyInject(null, { body: { x: 1 } }, ctx).changed, false);
  assert.equal(applyBodyInject('not-an-object', { body: { x: 1 } }, ctx).changed, false);
});

test('applyBodyInject 把点路径写法展开成嵌套对象', () => {
  const ctx = createContext({ session: { id: 'ses_9' } });
  const body = {};

  applyBodyInject(
    body,
    {
      body: { 'metadata.trace': '{{session.id}}', 'metadata.channel': 'proxy', temperature: 0.3 },
      overwrite: true,
    },
    ctx,
  );

  assert.deepEqual(body, {
    metadata: { trace: 'ses_9', channel: 'proxy' },
    temperature: 0.3,
  });
});

test('buildInjectHeaders 渲染模板并把头名统一成小写', () => {
  const ctx = createContext({ session: { id: 'ses_1', count: 3, requestId: 'msg_3' } });

  const headers = buildInjectHeaders(
    {
      headers: {
        'X-Session-Id': '{{session.id}}',
        'x-request-id': '{{session.requestId}}',
        'x-static': 'cli',
      },
      overwrite: true,
    },
    ctx,
  );

  assert.deepEqual(headers, {
    'x-session-id': 'ses_1',
    'x-request-id': 'msg_3',
    'x-static': 'cli',
  });
});

test('buildInjectHeaders 跳过 null 与渲染为空的项', () => {
  const ctx = createContext();

  const headers = buildInjectHeaders(
    { headers: { 'x-a': null, 'x-b': '{{missing.path}}', 'x-c': 'v', 'x-d': undefined }, overwrite: true },
    ctx,
  );

  assert.deepEqual(headers, { 'x-c': 'v' });
});

test('buildInjectHeaders 在 overwrite=false 时保留客户端已有头', () => {
  const ctx = createContext({ session: { id: 'ses_1' } });
  const existing = new Map([['x-opencode-session', 'client-value']]);

  const headers = buildInjectHeaders(
    { headers: { 'x-opencode-session': '{{session.id}}', 'x-new': 'v' }, overwrite: false },
    ctx,
    existing,
  );

  assert.deepEqual(headers, { 'x-new': 'v' });
});

test('buildInjectHeaders 对空配置返回空对象', () => {
  const ctx = createContext();
  assert.deepEqual(buildInjectHeaders({ headers: {} }, ctx), {});
  assert.deepEqual(buildInjectHeaders({}, ctx), {});
  assert.deepEqual(buildInjectHeaders(undefined, ctx), {});
});

test('rewriteModel 回报解析过程，供上层决定要不要告警', () => {
  const mapped = rewriteModel({ model: 'proxy-fast' }, modelConfig({ map: { fast: 'glm-5.3-flash' } }));
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.strippedPrefix, 'proxy-');
  assert.equal(mapped.usedDefault, false);
  assert.equal(mapped.unmappedAlias, false);

  const direct = rewriteModel({ model: 'fast' }, modelConfig({ map: { fast: 'glm-5.3-flash' } }));
  assert.equal(direct.mapped, true);
  assert.equal(direct.strippedPrefix, null, '原始名直接命中时没有剥任何前缀');
  assert.equal(direct.unmappedAlias, false);

  const unmapped = rewriteModel({ model: 'proxy-nope' }, modelConfig());
  assert.equal(unmapped.changed, true);
  assert.equal(unmapped.mapped, false);
  assert.equal(unmapped.strippedPrefix, 'proxy-');
  assert.equal(unmapped.usedDefault, false);
  assert.equal(unmapped.unmappedAlias, true, '剥了前缀但没命中映射 —— 这才是要告警的情况');

  const passthrough = rewriteModel({ model: 'glm-5.3' }, modelConfig());
  assert.equal(passthrough.changed, false);
  assert.equal(passthrough.unmappedAlias, false, '客户端直接填真实 ID 属于正常透传，不该告警');

  const fallback = rewriteModel({ model: 'unknown' }, modelConfig({ default: 'fallback' }));
  assert.equal(fallback.usedDefault, true);
  assert.equal(fallback.unmappedAlias, false, '有兜底就不算未命中');
});

test('model.default 不兜底「剥完前缀仍无映射」的名字，仍会告警', () => {
  const result = rewriteModel({ model: 'proxy-nope' }, modelConfig({ default: 'fallback' }));

  assert.equal(result.usedDefault, false);
  assert.equal(result.unmappedAlias, true);
  assert.equal(result.to, 'nope', '结果是剥完前缀的名字，而不是 default');
});

test('rewriteModel 关闭时不做任何回报', () => {
  const result = rewriteModel({ model: 'proxy-x' }, modelConfig({ enabled: false }));
  assert.equal(result.changed, false);
  assert.equal(result.unmappedAlias, undefined);
});
