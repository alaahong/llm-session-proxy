import assert from 'node:assert/strict';
import test from 'node:test';

import { setLang, t } from '../src/messages.js';
import {
  REQUEST_PHASE,
  RESPONSE_PHASE,
  applyTransformers,
  describeTransformers,
  getTransformer,
  isTransformer,
  listTransformers,
} from '../src/transformers.js';

setLang('en');

test('注册表内容稳定：五个内置变换，全部是请求相位', () => {
  assert.deepEqual(listTransformers(), [
    'noop',
    'drop-fields',
    'drop-empty-fields',
    'rename-fields',
    'clamp-max-tokens',
  ]);
  for (const name of listTransformers()) {
    assert.equal(getTransformer(name).phase, REQUEST_PHASE, `${name} 应当是请求相位`);
    assert.equal(isTransformer(name), true);
  }
  assert.equal(isTransformer('nope'), false);
  assert.equal(getTransformer('nope'), null);
  assert.equal(REQUEST_PHASE, 'request');
  assert.equal(RESPONSE_PHASE, 'response');
});

test('describeTransformers 给出名字、相位与本地化描述', () => {
  const described = describeTransformers();
  assert.equal(described.length, listTransformers().length);

  const noop = described.find((entry) => entry.name === 'noop');
  assert.equal(noop.description, t('transformer.noop'));

  setLang('zh');
  const zh = describeTransformers().find((entry) => entry.name === 'noop');
  assert.equal(zh.description, t('transformer.noop'));
  assert.notEqual(zh.description, noop.description, '描述应当随语言变化');
  setLang('en');
});

test('noop 什么都不改，也不报告变化', () => {
  const body = { model: 'glm-5.3', temperature: 0.2 };
  const snapshot = JSON.stringify(body);
  const result = applyTransformers(body, ['noop']);

  assert.equal(result.changed, false);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.applied, ['noop']);
  assert.equal(JSON.stringify(body), snapshot);
});

test('drop-fields 支持点路径，且不报没删到的东西', () => {
  const body = { model: 'm', temperature: 0.2, metadata: { trace: 'x', keep: 1 }, tools: [] };
  const result = applyTransformers(body, ['drop-fields'], {
    options: { 'drop-fields': { fields: ['temperature', 'metadata.trace', 'not_there'] } },
  });

  assert.deepEqual(body, { model: 'm', metadata: { keep: 1 }, tools: [] });
  assert.deepEqual(result.changes, ['drop-fields:-temperature', 'drop-fields:-metadata.trace']);
});

test('drop-empty-fields 清掉 null / "" / [] / {}，保留 0 与 false', () => {
  const body = {
    model: 'm',
    temperature: 0,
    stream: false,
    tools: [],
    metadata: {},
    stop: '',
    presence_penalty: null,
  };
  applyTransformers(body, ['drop-empty-fields']);

  assert.deepEqual(body, { model: 'm', temperature: 0, stream: false });
});

test('drop-empty-fields 给了 fields 时只动列出来的字段', () => {
  const body = { model: 'm', tools: [], stop: '', metadata: {} };
  applyTransformers(body, ['drop-empty-fields'], { options: { 'drop-empty-fields': { fields: ['tools'] } } });

  assert.deepEqual(body, { model: 'm', stop: '', metadata: {} });
});

test('rename-fields 搬迁取值，原字段消失，缺失的字段不报错', () => {
  const body = { model: 'm', max_completion_tokens: 512 };
  applyTransformers(body, ['rename-fields'], {
    options: { 'rename-fields': { map: { max_completion_tokens: 'max_tokens', missing: 'nope' } } },
  });

  assert.deepEqual(body, { model: 'm', max_tokens: 512 });
  assert.equal('max_completion_tokens' in body, false);
});

test('rename-fields 支持嵌套点路径，且同名映射会被忽略', () => {
  const body = { a: { b: 1 }, c: 2 };
  applyTransformers(body, ['rename-fields'], {
    options: { 'rename-fields': { map: { 'a.b': 'c', c: 'c' } } },
  });

  assert.deepEqual(body, { a: {}, c: 1 });
});

test('clamp-max-tokens 只往下压，超限才改', () => {
  const body = { model: 'm', max_tokens: 100000 };
  applyTransformers(body, ['clamp-max-tokens'], { options: { 'clamp-max-tokens': { max: 32000 } } });
  assert.equal(body.max_tokens, 32000);

  const small = { model: 'm', max_tokens: 100 };
  applyTransformers(small, ['clamp-max-tokens'], { options: { 'clamp-max-tokens': { max: 32000 } } });
  assert.equal(small.max_tokens, 100, '没超限就不动');

  // 没配 max 或者 max 非法 → 整个变换不生效，而不是压成 0
  const untouched = { model: 'm', max_tokens: 999999 };
  applyTransformers(untouched, ['clamp-max-tokens'], { options: {} });
  assert.equal(untouched.max_tokens, 999999);
  applyTransformers(untouched, ['clamp-max-tokens'], { options: { 'clamp-max-tokens': { max: 'abc' } } });
  assert.equal(untouched.max_tokens, 999999);

  // 默认同时管两个字段名
  const both = { max_tokens: 90000, max_completion_tokens: 80000 };
  applyTransformers(both, ['clamp-max-tokens'], { options: { 'clamp-max-tokens': { max: 1000 } } });
  assert.deepEqual(both, { max_tokens: 1000, max_completion_tokens: 1000 });
});

test('按数组顺序执行，顺序真的会改变结果', () => {
  const options = {
    'rename-fields': { map: { a: 'b' } },
    'drop-fields': { fields: ['b'] },
  };

  // 先改名再删：刚搬过来的 b 被删掉了
  const renamedThenDropped = { a: 1, keep: 2 };
  applyTransformers(renamedThenDropped, ['rename-fields', 'drop-fields'], { options });
  assert.deepEqual(renamedThenDropped, { keep: 2 });

  // 先删再改名：删的时候还没有 b，改名后 b 反而留下了
  const droppedThenRenamed = { a: 1, keep: 2 };
  applyTransformers(droppedThenRenamed, ['drop-fields', 'rename-fields'], { options });
  assert.deepEqual(droppedThenRenamed, { keep: 2, b: 1 });
});

test('clamp-max-tokens 认识两个字段名，所以与改名之间没有顺序依赖', () => {
  const options = {
    'rename-fields': { map: { max_completion_tokens: 'max_tokens' } },
    'clamp-max-tokens': { max: 100 },
  };

  const a = { model: 'm', max_completion_tokens: 99999 };
  applyTransformers(a, ['rename-fields', 'clamp-max-tokens'], { options });
  assert.deepEqual(a, { model: 'm', max_tokens: 100 });

  const b = { model: 'm', max_completion_tokens: 99999 };
  applyTransformers(b, ['clamp-max-tokens', 'rename-fields'], { options });
  assert.deepEqual(b, { model: 'm', max_tokens: 100 }, '两个字段名都管，所以先压后压结果一致');
});

test('未注册的名字被跳过并记账，不会中断后面的变换', () => {
  const body = { model: 'm', tools: [] };
  const result = applyTransformers(body, ['nope', 'drop-empty-fields', 'also-nope']);

  assert.deepEqual(result.skipped, ['nope', 'also-nope']);
  assert.deepEqual(result.applied, ['drop-empty-fields']);
  assert.deepEqual(body, { model: 'm' }, '合法的那个照样执行');
});

test('非对象 body 不参与变换，返回空结果', () => {
  for (const body of [null, undefined, 42, 'text', ['a']]) {
    const result = applyTransformers(body, ['noop']);
    assert.equal(result.changed, false);
    assert.deepEqual(result.applied, []);
  }
});

test('空名单是合法的空操作', () => {
  const body = { model: 'm' };
  const result = applyTransformers(body, []);
  assert.deepEqual(result, { changed: false, applied: [], skipped: [], changes: [] });
});
