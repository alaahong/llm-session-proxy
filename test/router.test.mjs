import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfig } from '../src/config.js';
import { setLang } from '../src/messages.js';
import {
  BUILTIN_BUCKETS,
  applyBucketModel,
  composeTransformers,
  describeBuckets,
  describeRule,
  emptyBucket,
  getBucket,
  hasMatcher,
  matchRule,
  normalizeRule,
  resolveRoute,
} from '../src/router.js';

setLang('en');

/** 一份典型的三桶配置：messages 走 think、超长走 longContext、其余 default。 */
function routerConfig(extra = {}) {
  return buildConfig({
    env: { LSP_HOME: '/tmp/lsp-router' },
    flags: {
      router: {
        enabled: true,
        buckets: {
          think: { model: 'glm-5.3-think', transformers: ['drop-empty-fields'] },
          longContext: { model: 'glm-5.3-long' },
        },
        rules: [
          { bucket: 'think', path: '/zen/go/v1/messages' },
          { bucket: 'think', modelPrefix: 'proxy-think' },
          { bucket: 'longContext', minBytes: 60000 },
        ],
      },
      ...extra,
    },
  }).router;
}

test('默认配置里四个内置桶都已声明，且都是空桶', () => {
  const config = buildConfig({ env: { LSP_HOME: '/tmp/lsp-router' } });

  assert.equal(config.router.enabled, false, 'router 默认关闭，升级不应改变既有行为');
  assert.deepEqual(Object.keys(config.router.buckets).sort(), [...BUILTIN_BUCKETS].sort());
  for (const name of BUILTIN_BUCKETS) {
    assert.deepEqual(getBucket(config.router, name), emptyBucket());
  }
});

test('router 关闭时一切请求都落在 default，且标记来源为 disabled', () => {
  const config = buildConfig({ env: { LSP_HOME: '/tmp/lsp-router' } });
  const route = resolveRoute({ path: '/zen/go/v1/messages' }, config.router);

  assert.equal(route.bucket, 'default');
  assert.equal(route.source, 'disabled');
});

test('规则自上而下，首个命中生效', () => {
  // 两条规则都会命中同一个请求，应当取 #0
  const config = buildConfig({
    env: { LSP_HOME: '/tmp/lsp-router' },
    flags: {
      router: {
        enabled: true,
        buckets: { think: { model: 'a' }, background: { model: 'b' } },
        rules: [
          { bucket: 'think', path: '/zen/go/v1/messages' },
          { bucket: 'background', path: '/zen/go/v1' },
        ],
      },
    },
  }).router;

  const route = resolveRoute({ path: '/zen/go/v1/messages' }, config);
  assert.equal(route.bucket, 'think');
  assert.equal(route.ruleIndex, 0);
  assert.equal(route.source, 'rule');
});

test('同一条规则内的多个条件是 AND，只满足一个不算命中', () => {
  const rule = normalizeRule({ bucket: 'think', path: '/v1/messages', modelPrefix: 'proxy-think' });

  assert.equal(matchRule({ path: '/v1/messages', clientModel: 'proxy-think' }, rule).matched, true);
  assert.equal(matchRule({ path: '/v1/messages', clientModel: 'proxy-glm' }, rule).matched, false);
  assert.equal(matchRule({ path: '/v1/chat', clientModel: 'proxy-think' }, rule).matched, false);
});

test('modelPrefix 同时匹配客户端原始名与解析后的真实 ID', () => {
  const rule = normalizeRule({ bucket: 'think', modelPrefix: 'glm-5.3' });

  // 解析前叫 proxy-think，解析后才是 glm-5.3-think：两个候选里命中一个即可
  assert.equal(matchRule({ clientModel: 'proxy-think', resolvedModel: 'glm-5.3-think' }, rule).matched, true);
  assert.equal(matchRule({ clientModel: 'proxy-glm', resolvedModel: 'glm-5.3' }, rule).matched, true);
  assert.equal(matchRule({ clientModel: 'proxy-kimi', resolvedModel: 'kimi-k3' }, rule).matched, false);
});

test('bodyField 支持存在性判定与取值判定两种写法', () => {
  const exists = normalizeRule({ bucket: 'think', bodyField: 'thinking' });
  assert.equal(matchRule({ body: { thinking: { type: 'enabled' } } }, exists).matched, true);
  assert.equal(matchRule({ body: { thinking: null } }, exists).matched, false);
  assert.equal(matchRule({ body: {} }, exists).matched, false);
  // 空数组/空串都视为"没有"
  assert.equal(matchRule({ body: { thinking: [] } }, exists).matched, false);
  assert.equal(matchRule({ body: { thinking: '' } }, exists).matched, false);

  const equals = normalizeRule({ bucket: 'background', bodyField: 'metadata.kind', bodyFieldValue: 'background' });
  assert.equal(matchRule({ body: { metadata: { kind: 'background' } } }, equals).matched, true);
  assert.equal(matchRule({ body: { metadata: { kind: 'chat' } } }, equals).matched, false);
});

test('minBytes / maxBytes 按请求体字节数判定', () => {
  const long = normalizeRule({ bucket: 'longContext', minBytes: 60000 });
  assert.equal(matchRule({ byteLength: 60000 }, long).matched, true, '等于阈值要算命中');
  assert.equal(matchRule({ byteLength: 59999 }, long).matched, false);

  const short = normalizeRule({ bucket: 'background', maxBytes: 2048 });
  assert.equal(matchRule({ byteLength: 2048 }, short).matched, true);
  assert.equal(matchRule({ byteLength: 2049 }, short).matched, false);

  const band = normalizeRule({ bucket: 'default', minBytes: 100, maxBytes: 200 });
  assert.equal(matchRule({ byteLength: 150 }, band).matched, true);
  assert.equal(matchRule({ byteLength: 99 }, band).matched, false);
  assert.equal(matchRule({ byteLength: 201 }, band).matched, false);
});

test('没有匹配条件的规则永不生效，配置校验会直接拦下来', () => {
  const bare = normalizeRule({ bucket: 'think' });
  assert.equal(hasMatcher(bare), false);
  assert.equal(matchRule({ path: '/anything' }, bare).matched, false, '不参与判定 ≠ 命中一切');

  // 启动时就报错，而不是留到运行时静默失效
  assert.throws(
    () =>
      buildConfig({
        env: { LSP_HOME: '/tmp/lsp-router' },
        flags: { router: { enabled: true, rules: [{ bucket: 'think' }] } },
      }),
    /has no matcher/,
  );

  // 即便绕过校验直接喂给 resolveRoute，也会被跳过并落到下一条
  const raw = {
    enabled: true,
    defaultBucket: 'default',
    buckets: { default: emptyBucket(), think: emptyBucket(), background: { model: 'b', transformers: [] } },
    rules: [{ bucket: 'think' }, { bucket: 'background', path: '/v1' }],
  };
  assert.equal(resolveRoute({ path: '/v1/chat' }, raw).bucket, 'background');
});

test('都不命中时落到 defaultBucket，且能把默认桶改成别的名字', () => {
  const config = buildConfig({
    env: { LSP_HOME: '/tmp/lsp-router' },
    flags: {
      router: {
        enabled: true,
        defaultBucket: 'background',
        buckets: { background: { model: 'cheap' } },
        rules: [{ bucket: 'background', path: '/never' }],
      },
    },
  }).router;

  const route = resolveRoute({ path: '/v1/chat' }, config);
  assert.equal(route.bucket, 'background');
  assert.equal(route.source, 'default');
});

test('--router 的强制桶压过规则，也压过 enabled=false', () => {
  const forced = buildConfig({
    env: { LSP_HOME: '/tmp/lsp-router' },
    flags: { router: { forced: 'think' } },
  }).router;
  assert.equal(forced.enabled, false, '默认仍是关闭');
  const route = resolveRoute({ path: '/zen/go/v1/messages' }, forced);
  assert.equal(route.bucket, 'think');
  assert.equal(route.source, 'forced');
});

test('applyBucketModel 只改模型字段，桶没配模型时原地不动', () => {
  const body = { model: 'glm-5.3', messages: [] };
  const untouched = applyBucketModel(body, emptyBucket(), { field: 'model' });
  assert.equal(untouched.changed, false);
  assert.equal(body.model, 'glm-5.3');

  const changed = applyBucketModel(body, getBucket(routerConfig(), 'think'), { field: 'model' });
  assert.equal(changed.changed, true);
  assert.equal(changed.from, 'glm-5.3');
  assert.equal(changed.to, 'glm-5.3-think');
  assert.equal(body.model, 'glm-5.3-think');
});

test('applyBucketModel 尊重自定义的模型字段名', () => {
  const body = { model_name: 'a' };
  applyBucketModel(body, { model: 'b' }, { field: 'model_name' });
  assert.equal(body.model_name, 'b');
  assert.equal(body.model, undefined, '不该凭空造出默认字段');
});

test('composeTransformers 把全局与桶合并，全局在前且去掉重复', () => {
  const bucket = { model: null, transformers: ['drop-empty-fields', 'noop'] };

  assert.deepEqual(composeTransformers({ enabled: ['noop'] }, bucket), ['noop', 'drop-empty-fields']);
  assert.deepEqual(composeTransformers({ enabled: [] }, bucket), ['drop-empty-fields', 'noop']);
  assert.deepEqual(composeTransformers({ enabled: ['a', 'a'] }, emptyBucket()), ['a']);
  assert.deepEqual(composeTransformers({}, emptyBucket()), []);
});

test('describeBuckets 列出内置四桶，自定义桶也会出现', () => {
  const described = describeBuckets(routerConfig());

  assert.deepEqual(
    described.map((entry) => entry.name),
    BUILTIN_BUCKETS,
  );
  const think = described.find((entry) => entry.name === 'think');
  assert.equal(think.model, 'glm-5.3-think');
  assert.deepEqual(think.transformers, ['drop-empty-fields']);
  assert.equal(think.declared, true);

  const background = described.find((entry) => entry.name === 'background');
  assert.equal(background.declared, true, '默认配置里就已经声明了四个桶');
  assert.equal(background.model, null);
  assert.deepEqual(background.transformers, []);

  // 自定义桶名追加在内置四个之后
  const custom = describeBuckets({ buckets: { ...routerConfig().buckets, image: { model: 'vision' } } });
  assert.equal(custom.at(-1).name, 'image');
  assert.equal(custom.at(-1).declared, true);
  assert.equal(custom.at(-1).model, 'vision');
});

test('describeRule 输出人能读的匹配式', () => {
  assert.equal(describeRule(normalizeRule({ bucket: 'think', path: '/v1' })), 'path^=/v1');
  assert.equal(describeRule(normalizeRule({ bucket: 'think', modelPrefix: 'p-' })), 'model~=p-*');
  assert.equal(
    describeRule(normalizeRule({ bucket: 'think', bodyField: 'metadata.kind', bodyFieldValue: 'x' })),
    'metadata.kind="x"',
  );
  assert.equal(describeRule(normalizeRule({ bucket: 'think', bodyField: 'thinking' })), 'has(thinking)');
  assert.equal(
    describeRule(normalizeRule({ bucket: 'think', path: '/v1', minBytes: 100, maxBytes: 200 })),
    'path^=/v1 AND bytes>=100 AND bytes<=200',
  );
});

test('阈值写成字符串也能用，负数与非数字会被归一化丢掉', () => {
  assert.equal(normalizeRule({ bucket: 'x', minBytes: '100' }).minBytes, 100);
  assert.equal(normalizeRule({ bucket: 'x', minBytes: 'abc' }).minBytes, undefined);
  assert.equal(normalizeRule({ bucket: 'x', maxBytes: -5 }).maxBytes, -5, '负数留给校验去报错');
});
