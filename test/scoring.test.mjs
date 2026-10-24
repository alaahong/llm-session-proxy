import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SCORERS,
  DEFAULT_BANDS,
  DEFAULT_WEIGHTS,
  bandFor,
  describeScorers,
  isScorer,
  listScorers,
  normalizeBands,
  resolveDifficulty,
  scoreRequest,
} from '../src/scoring.js';

// ---------------------------------------------------------------- 注册表

test('打分器注册表：内置一个，且是树内具名的', () => {
  assert.deepEqual(listScorers(), ['builtin-complexity']);
  assert.deepEqual(BUILTIN_SCORERS, ['builtin-complexity']);
  assert.equal(isScorer('builtin-complexity'), true);
  assert.equal(isScorer('builtin-nope'), false);
});

test('打分器描述表随语言变化', () => {
  const described = describeScorers();
  assert.equal(described.length, 1);
  assert.equal(described[0].name, 'builtin-complexity');
  assert.ok(described[0].description.length > 0);
});

// ---------------------------------------------------------------- 档位

test('默认档位是 easy / medium / hard 三档', () => {
  assert.deepEqual(DEFAULT_BANDS, [
    { name: 'easy', maxScore: 30 },
    { name: 'medium', maxScore: 60 },
    { name: 'hard', maxScore: 100 },
  ]);
});

test('bandFor 按 maxScore 落档，超出最高档落最高档', () => {
  const bands = [
    { name: 'easy', maxScore: 30 },
    { name: 'medium', maxScore: 60 },
    { name: 'hard', maxScore: 100 },
  ];
  assert.equal(bandFor(0, bands), 'easy');
  assert.equal(bandFor(30, bands), 'easy');
  assert.equal(bandFor(31, bands), 'medium');
  assert.equal(bandFor(60, bands), 'medium');
  assert.equal(bandFor(61, bands), 'hard');
  assert.equal(bandFor(100, bands), 'hard');
  assert.equal(bandFor(150, bands), 'hard');
});

test('normalizeBands 按 maxScore 升序排，非法项丢掉', () => {
  const bands = normalizeBands([
    { name: 'hard', maxScore: 100 },
    { name: 'easy', maxScore: 30 },
    { name: 'broken', maxScore: 'abc' },
    'not-an-object',
  ]);
  // 'broken' 的 maxScore 归一化成 0，所以排在最前
  assert.deepEqual(bands.map((b) => b.name), ['broken', 'easy', 'hard']);
  assert.equal(bands[0].maxScore, 0);
  assert.equal(bands[1].maxScore, 30);
});

test('normalizeBands 传空数组时退回内置三档', () => {
  assert.deepEqual(normalizeBands([]), DEFAULT_BANDS);
  assert.deepEqual(normalizeBands(null), DEFAULT_BANDS);
});

// ---------------------------------------------------------------- 打分

function chatBody(messages = [], extra = {}) {
  return { model: 'x', messages, ...extra };
}

test('零信号请求打成 0 分', () => {
  const result = scoreRequest({ body: chatBody([{ role: 'user', content: 'hi' }]), byteLength: 10 });
  assert.equal(result.score, 0);
  assert.deepEqual(result.scorers, ['builtin-complexity']);
});
test('代码块越多分越高', () => {
  const simple = scoreRequest({
    body: chatBody([{ role: 'user', content: 'hello world' }]),
    byteLength: 100,
  });
  const codey = scoreRequest({
    body: chatBody([
      {
        role: 'user',
        content: '```js\nconst a = 1;\n```\n```js\nconst b = 2;\n```\n```js\nconst c = 3;\n```',
      },
    ]),
    byteLength: 100,
  });
  assert.ok(codey.score > simple.score, `代码多应该分更高：${codey.score} vs ${simple.score}`);
  assert.ok(codey.signals.codeBlocks > 0);
});

test('diff 行数被算进分数', () => {
  const diff = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n');
  const result = scoreRequest({
    body: chatBody([{ role: 'user', content: diff }]),
    byteLength: 500,
  });
  assert.ok(result.signals.diffLines > 0);
  assert.ok(result.signals.diffLines <= 13, 'diff 行数的权重上限是 13');
});

test('diff 头部的 +++ / --- 不算作 diff 行', () => {
  const result = scoreRequest({
    body: chatBody([{ role: 'user', content: '+++ b/file.ts\n--- a/file.ts' }]),
    byteLength: 100,
  });
  assert.equal(result.signals.diffLines, 0);
});

test('文件路径被识别并去重', () => {
  const result = scoreRequest({
    body: chatBody([{ role: 'user', content: '看 src/index.ts 和 src/index.ts 还有 lib/util.ts' }]),
    byteLength: 200,
  });
  assert.ok(result.signals.files > 0);
});

test('工具定义数量进分数', () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({
    type: 'function',
    function: { name: `t${i}`, parameters: { type: 'object' } },
  }));
  const result = scoreRequest({ body: chatBody([{ role: 'user', content: 'x' }], { tools }), byteLength: 100 });
  assert.ok(result.signals.tools > 0);
});

test('明确要推理算高分', () => {
  const result = scoreRequest({
    body: chatBody([{ role: 'user', content: 'x' }], { reasoning_effort: 'high' }),
    byteLength: 100,
  });
  assert.ok(result.signals.reasoning > 0);
});

test('权重可以覆盖，且总分不会超过 100', () => {
  const heavy = scoreRequest(
    { body: chatBody([{ role: 'user', content: '```\ncode\n```' }]), byteLength: 100000 },
    { weights: { bytes: 200 } },
  );
  assert.ok(heavy.score <= 100, `总分不能超过 100，实际 ${heavy.score}`);
  assert.ok(heavy.score >= 50);
});

test('默认权重加起来是 100', () => {
  const total = Object.values(DEFAULT_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 100);
});

// ---------------------------------------------------------------- resolveDifficulty

test('没配打分器时 resolveDifficulty 返回 null', () => {
  assert.equal(resolveDifficulty({ body: chatBody() }, {}), null);
  assert.equal(resolveDifficulty({ body: chatBody() }, { scorers: { enabled: [] } }), null);
});

test('配了打分器就出分数与档位', () => {
  const result = resolveDifficulty(
    { body: chatBody([{ role: 'user', content: 'x' }]), byteLength: 100 },
    { scorers: { enabled: ['builtin-complexity'] } },
  );
  assert.ok(result);
  assert.equal(typeof result.score, 'number');
  assert.equal(result.band, 'easy');
  assert.deepEqual(result.scorers, ['builtin-complexity']);
  assert.ok(result.signals);
});

test('多个打分器叠加，分数相加后裁到 100', () => {
  const result = resolveDifficulty(
    { body: chatBody([{ role: 'user', content: 'x' }]), byteLength: 100 },
    { scorers: { enabled: ['builtin-complexity', 'builtin-complexity'] } },
  );
  assert.ok(result.score <= 100);
});

test('未注册的打分器被跳过，全是未注册时返回 null', () => {
  const result = resolveDifficulty(
    { body: chatBody() },
    { scorers: { enabled: ['nope-not-real'] } },
  );
  assert.equal(result, null);
});

test('自定义档位生效', () => {
  const result = resolveDifficulty(
    { body: chatBody([{ role: 'user', content: 'x' }]), byteLength: 100 },
    { scorers: { enabled: ['builtin-complexity'] }, bands: [{ name: 'tiny', maxScore: 0 }, { name: 'big', maxScore: 100 }] },
  );
  assert.equal(result.band, 'tiny');
});