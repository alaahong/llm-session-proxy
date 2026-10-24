import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BANDS,
  DEFAULT_WEIGHTS,
  bandFor,
  describeScorers,
  getScorer,
  isScorer,
  listScorers,
  normalizeBands,
  resolveDifficulty,
  scoreRequest,
} from '../src/scoring.js';

/**
 * 难度打分的分支覆盖。
 *
 * scoring.test.mjs 覆盖的是「信号怎么加权」，这里补的是**信号提取的边缘形态**：
 * 三种协议的正文位置不同、分段内容可以嵌套、system 可以在多处出现、
 * 以及各种「不是对象」的输入。
 *
 * 判据统一：打分器**不抛异常**。请求体形状不对时按 0 分算，
 * 而不是把请求带崩——打分是在请求进代理的**最前端**做的。
 */

// ---------------------------------------------------------------- 打分器本体

/** 直接跑内置打分器，拿信号明细。 */
function signalsFor(body, byteLength = 0) {
  const scorer = getScorer('builtin-complexity');
  const result = scorer.score({ body, byteLength }, { options: {} });
  return result.signals;
}

test('body 不是对象时所有信号都是 0', () => {
  const result = getScorer('builtin-complexity').score({ body: 'not an object', byteLength: 0 }, { options: {} });
  assert.equal(result.score, 0);
  assert.deepEqual(Object.values(result.signals), new Array(Object.keys(result.signals).length).fill(0));
});

test('byteLength 不是有限数时按 0 算', () => {
  const result = getScorer('builtin-complexity').score({ body: {}, byteLength: NaN }, { options: {} });
  assert.equal(result.signals.bytes, 0);
});

test('body 缺省时按空 body 处理', () => {
  const result = getScorer('builtin-complexity').score({}, { options: {} });
  assert.equal(result.score, 0);
});

test('chat 的分段内容里的 text 被计入', () => {
  const signals = signalsFor({
    messages: [{ role: 'user', content: [{ type: 'text', text: '```js\ncode\n```' }] }],
  });
  assert.ok(signals.codeBlocks > 0, '代码块信号应该有分');
});

test('chat 的分段内容里 item.content 是字符串时被计入', () => {
  const signals = signalsFor({
    messages: [{ role: 'user', content: [{ type: 'text', content: '```js\ncode\n```' }] }],
  });
  assert.ok(signals.codeBlocks > 0);
});

test('chat 的分段内容里 item.content 是数组时递归计入', () => {
  const signals = signalsFor({
    messages: [{ role: 'user', content: [{ type: 'wrapper', content: [{ type: 'text', text: '```js\ncode\n```' }] }] }],
  });
  assert.ok(signals.codeBlocks > 0);
});

test('chat 的分段内容里 item 是字符串时被计入', () => {
  const signals = signalsFor({
    messages: [{ role: 'user', content: ['```js\ncode\n```'] }],
  });
  assert.ok(signals.codeBlocks > 0);
});

test('responses 的 input 是字符串数组时文本被计入', () => {
  const signals = signalsFor({
    input: ['```js\ncode\n```'],
  });
  assert.ok(signals.codeBlocks > 0);
});

test('responses 的 input 是对象数组时文本被计入', () => {
  const signals = signalsFor({
    input: [{ type: 'message', content: [{ type: 'input_text', text: '```js\ncode\n```' }] }],
  });
  assert.ok(signals.codeBlocks > 0);
});

test('responses 的 input 是对象但没有 content 时不炸', () => {
  const signals = signalsFor({ input: [{ type: 'reasoning' }] });
  assert.equal(typeof signals.codeBlocks, 'number');
});

test('system 是数组时分段内容被计入', () => {
  const signals = signalsFor({
    system: [{ type: 'text', text: 'x'.repeat(4000) }],
    messages: [],
  });
  assert.ok(signals.system > 0, 'system 信号应该有分');
});

test('system 出现在 messages 里（role=system）时被计入', () => {
  const signals = signalsFor({
    messages: [{ role: 'system', content: 'x'.repeat(4000) }],
  });
  assert.ok(signals.system > 0);
});

test('developer 角色的消息也算 system', () => {
  const signals = signalsFor({
    messages: [{ role: 'developer', content: 'x'.repeat(4000) }],
  });
  assert.ok(signals.system > 0);
});

test('instructions 优先于 system 被当成 system 长度', () => {
  const signals = signalsFor({
    instructions: 'x'.repeat(4000),
    system: 'y'.repeat(4000),
    messages: [],
  });
  assert.ok(signals.system > 0);
});

test('max_tokens 的四种名字都被认', () => {
  assert.ok(signalsFor({ max_tokens: 9000 }).maxTokens > 0);
  assert.ok(signalsFor({ max_completion_tokens: 9000 }).maxTokens > 0);
  assert.ok(signalsFor({ max_output_tokens: 9000 }).maxTokens > 0);
  assert.ok(signalsFor({ generationConfig: { maxOutputTokens: 9000 } }).maxTokens > 0);
});

test('max_tokens 不是有限数时按没有算', () => {
  assert.equal(signalsFor({ max_tokens: 'lots' }).maxTokens, 0);
});

test('thinking 预算达到 8192 时给满值', () => {
  const signals = signalsFor({ thinking: { budget_tokens: 8192 } });
  assert.equal(signals.reasoning, DEFAULT_WEIGHTS.reasoning);
});

test('thinking 预算不足 8192 时给一半', () => {
  const signals = signalsFor({ thinking: { budget_tokens: 1024 } });
  assert.equal(signals.reasoning, Math.round(DEFAULT_WEIGHTS.reasoning * 0.5));
});

test('gemini 的 thinkingConfig 也被认', () => {
  const signals = signalsFor({ generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } });
  assert.equal(signals.reasoning, DEFAULT_WEIGHTS.reasoning);
});

test('reasoning_effort=high 给满值，其他给一半', () => {
  assert.equal(signalsFor({ reasoning_effort: 'high' }).reasoning, DEFAULT_WEIGHTS.reasoning);
  assert.equal(signalsFor({ reasoning_effort: 'low' }).reasoning, Math.round(DEFAULT_WEIGHTS.reasoning * 0.5));
});

test('responses 的 reasoning.effort 也被认', () => {
  assert.equal(signalsFor({ reasoning: { effort: 'high' } }).reasoning, DEFAULT_WEIGHTS.reasoning);
  assert.equal(signalsFor({ reasoning: { effort: 'medium' } }).reasoning, Math.round(DEFAULT_WEIGHTS.reasoning * 0.5));
});

test('只有 thinking/reasoning 的壳子没有预算时给一半', () => {
  assert.equal(signalsFor({ thinking: { type: 'enabled' } }).reasoning, Math.round(DEFAULT_WEIGHTS.reasoning * 0.5));
  assert.equal(signalsFor({ reasoning: {} }).reasoning, Math.round(DEFAULT_WEIGHTS.reasoning * 0.5));
});

test('完全不要推理时给 0 分', () => {
  assert.equal(signalsFor({ messages: [] }).reasoning, 0);
});

test('字节数不足 512 时不加分', () => {
  assert.equal(signalsFor({ messages: [] }, 100).bytes, 0);
  assert.ok(signalsFor({ messages: [] }, 4096).bytes > 0);
});

test('轮数用 messages 数组的长度', () => {
  assert.equal(signalsFor({ messages: [{ role: 'user', content: 'x' }] }).turns, 0);
  assert.ok(signalsFor({ messages: [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }] }).turns > 0);
});

test('轮数用 responses 的 input 数组的长度', () => {
  assert.ok(signalsFor({ input: ['a', 'b', 'c'] }).turns > 0);
});

test('工具数量进分数', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ type: 'function', function: { name: `f${i}` } }));
  assert.ok(signalsFor({ tools: many, messages: [] }).tools > 0);
});

test('tools 不是数组时按 0 算', () => {
  assert.equal(signalsFor({ tools: 'nope' }).tools, 0);
});

test('权重里有多余的键时按 0 分算，不会炸', () => {
  const scorer = getScorer('builtin-complexity');
  const result = scorer.score(
    { body: { messages: [] }, byteLength: 0 },
    { options: { weights: { notASignal: 10 } } },
  );
  assert.equal(result.signals.notASignal, 0);
  assert.equal(typeof result.score, 'number');
});

test('权重不是数字时按 0 算', () => {
  const scorer = getScorer('builtin-complexity');
  const result = scorer.score(
    { body: { messages: [] }, byteLength: 0 },
    { options: { weights: { bytes: 'heavy' } } },
  );
  assert.equal(result.signals.bytes, 0);
});

// ---------------------------------------------------------------- 注册表

test('注册表：只有一个内置打分器', () => {
  assert.deepEqual(listScorers(), ['builtin-complexity']);
});

test('注册表：未注册的名字取不到', () => {
  assert.equal(getScorer('nope'), null);
  assert.equal(isScorer('nope'), false);
  assert.equal(isScorer('builtin-complexity'), true);
});

test('注册表：describeScorers 给出名字与说明', () => {
  const list = describeScorers();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'builtin-complexity');
  assert.ok(list[0].description, '要有说明文字');
});

// ---------------------------------------------------------------- 档位

test('默认档位的三档 maxScore 递增', () => {
  const scores = DEFAULT_BANDS.map((band) => band.maxScore);
  assert.deepEqual([...scores].sort((a, b) => a - b), scores);
});

test('bandFor：负分落最低档', () => {
  assert.equal(bandFor(-5), DEFAULT_BANDS[0].name);
});

test('bandFor：正好在边界上落本档（区间是闭的）', () => {
  assert.equal(bandFor(DEFAULT_BANDS[0].maxScore), DEFAULT_BANDS[0].name);
  assert.equal(bandFor(DEFAULT_BANDS[0].maxScore + 1), DEFAULT_BANDS[1].name);
});

test('bandFor：远高于最高档也落最高档', () => {
  assert.equal(bandFor(9999), DEFAULT_BANDS[DEFAULT_BANDS.length - 1].name);
});

test('bandFor：分数不是数字时按 0 算', () => {
  assert.equal(bandFor('abc'), DEFAULT_BANDS[0].name);
});

test('bandFor：自定义档位也生效', () => {
  assert.equal(bandFor(5, [{ name: 'small', maxScore: 10 }]), 'small');
});

test('normalizeBands：maxScore 不是数字时按 0 算', () => {
  const bands = normalizeBands([{ name: 'a', maxScore: 'high' }]);
  assert.equal(bands[0].maxScore, 0);
});

test('normalizeBands：没有名字的项被丢掉', () => {
  const bands = normalizeBands([{ name: '', maxScore: 10 }, { maxScore: 20 }]);
  assert.equal(bands.length, DEFAULT_BANDS.length);
});

test('normalizeBands：全是非法项时退回内置三档', () => {
  const bands = normalizeBands(['x', 42, null]);
  assert.equal(bands.length, DEFAULT_BANDS.length);
});

test('normalizeBands：不是数组时退回内置三档', () => {
  assert.equal(normalizeBands('nope').length, DEFAULT_BANDS.length);
  assert.equal(normalizeBands(null).length, DEFAULT_BANDS.length);
});

// ---------------------------------------------------------------- 入口

test('scoreRequest：没有 body 时给 0 分', () => {
  assert.equal(scoreRequest().score, 0);
});

test('scoreRequest：指定打分器名', () => {
  const result = scoreRequest({ body: { messages: [] }, byteLength: 0 }, { enabled: ['builtin-complexity'] });
  assert.equal(result.score, 0);
  assert.deepEqual(result.scorers, ['builtin-complexity']);
});

test('scoreRequest：enabled 是空数组时返回 null', () => {
  assert.equal(scoreRequest({ body: {} }, { enabled: [] }), null);
});

test('scoreRequest：未注册的打分器全被跳过时返回 null', () => {
  assert.equal(scoreRequest({ body: {} }, { enabled: ['nope'] }), null);
});

test('scoreRequest：便捷形式只覆盖内置打分器的权重', () => {
  const result = scoreRequest(
    { body: { messages: [{ role: 'user', content: 'x'.repeat(2000) }] }, byteLength: 8192 },
    { weights: { bytes: 100 } },
  );
  assert.ok(result.score > 0);
  assert.deepEqual(result.scorers, ['builtin-complexity']);
});

test('resolveDifficulty：router 里没开打分器时返回 null', () => {
  assert.equal(resolveDifficulty({ body: {} }, {}), null);
});

test('resolveDifficulty：scorers.enabled 不是数组时返回 null', () => {
  assert.equal(resolveDifficulty({ body: {} }, { scorers: { enabled: true } }), null);
});

test('resolveDifficulty：配了打分器就出分数与档位', () => {
  const result = resolveDifficulty(
    { body: { messages: [{ role: 'user', content: 'x'.repeat(2000) }] }, byteLength: 4096 },
    { scorers: { enabled: ['builtin-complexity'] } },
  );
  assert.ok(result);
  assert.ok(result.score > 0);
  assert.ok(result.band);
  assert.deepEqual(result.scorers, ['builtin-complexity']);
});

test('resolveDifficulty：自定义档位生效', () => {
  const result = resolveDifficulty(
    { body: { messages: [{ role: 'user', content: 'x'.repeat(4000) }] }, byteLength: 8192 },
    {
      scorers: { enabled: ['builtin-complexity'] },
      bands: [{ name: 'big', maxScore: 1 }],
    },
  );
  assert.equal(result.band, 'big');
});
