import assert from 'node:assert/strict';
import test from 'node:test';

import { convertResponseJson, listResponseConverters } from '../src/replies.js';

/**
 * 响应体互转的分支覆盖。
 *
 * 这里的重点不是「主干能跑通」（那份测试已有），而是**边缘分支**：
 * 空的 content、不是 JSON 的工具参数、缺 usage、未知块类型、
 * 经 chat 中转时的两段丢弃项合并。
 *
 * 判据统一：转换器要么把字段映射对，要么把丢掉的字段**记名**报出来。
 * 「静默丢掉」是这个项目最忌讳的行为。
 */

// ---------------------------------------------------------------- messages → chat

test('messages->chat：只有 tool_use 时 content 为 null', () => {
  const result = convertResponseJson(
    {
      id: 'msg_1',
      model: 'claude-x',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'hi' } }],
      stop_reason: 'tool_use',
    },
    'messages',
    'chat',
  );
  assert.equal(result.changed, true);
  assert.equal(result.payload.choices[0].message.content, null);
  assert.equal(result.payload.choices[0].message.tool_calls.length, 1);
  assert.equal(result.payload.choices[0].finish_reason, 'tool_calls');
  // tool_use 的 input 是对象，要序列化成字符串
  assert.equal(result.payload.choices[0].message.tool_calls[0].function.arguments, '{"q":"hi"}');
});

test('messages->chat：tool_use 缺 input 时给空对象', () => {
  const result = convertResponseJson(
    { id: 'm', model: 'x', content: [{ type: 'tool_use', id: 't', name: 'n' }] },
    'messages',
    'chat',
  );
  assert.equal(result.payload.choices[0].message.tool_calls[0].function.arguments, '{}');
});

test('messages->chat：未知块类型记名丢弃', () => {
  const result = convertResponseJson(
    { id: 'm', model: 'x', content: [{ type: 'redacted_thinking' }, { type: 'text', text: 'ok' }] },
    'messages',
    'chat',
  );
  assert.deepEqual(result.dropped, ['block:redacted_thinking']);
  assert.equal(result.payload.choices[0].message.content, 'ok');
});

test('messages->chat：没有 type 的块按 unknown 记名', () => {
  const result = convertResponseJson({ id: 'm', model: 'x', content: [{}] }, 'messages', 'chat');
  assert.deepEqual(result.dropped, ['block:unknown']);
});

test('messages->chat：content 不是数组时当单块处理', () => {
  const result = convertResponseJson(
    { id: 'm', model: 'x', content: { type: 'text', text: 'single' } },
    'messages',
    'chat',
  );
  assert.equal(result.payload.choices[0].message.content, 'single');
});

test('messages->chat：content 缺失时 message 既无 content 也无 tool_calls', () => {
  const result = convertResponseJson({ id: 'm', model: 'x' }, 'messages', 'chat');
  const message = result.payload.choices[0].message;
  assert.equal(message.content, undefined);
  assert.equal(message.tool_calls, undefined);
});

test('messages->chat：stop_reason 各种取值都映射到 finish_reason', () => {
  const cases = [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
    ['weird_value', 'stop'],
  ];
  for (const [stopReason, finishReason] of cases) {
    const result = convertResponseJson(
      { id: 'm', model: 'x', content: [{ type: 'text', text: 't' }], stop_reason: stopReason },
      'messages',
      'chat',
    );
    assert.equal(result.payload.choices[0].finish_reason, finishReason, `stop_reason=${stopReason}`);
  }
});

test('messages->chat：usage 缺失时三个 token 数都是 0', () => {
  const result = convertResponseJson({ id: 'm', model: 'x', content: [] }, 'messages', 'chat');
  assert.deepEqual(result.payload.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

test('messages->chat：cache_read_input_tokens 有值时带过去', () => {
  const result = convertResponseJson(
    {
      id: 'm',
      model: 'x',
      content: [],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
    },
    'messages',
    'chat',
  );
  assert.equal(result.payload.usage.cache_read_input_tokens, 7);
});

test('messages->chat：cache_read_input_tokens 为 0 时也带过去', () => {
  const result = convertResponseJson(
    { id: 'm', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    'messages',
    'chat',
  );
  // 0 是有效值，不该被当成「没有」
  assert.equal(result.payload.usage.cache_read_input_tokens, 0);
});

// ---------------------------------------------------------------- chat → messages

test('chat->messages：content 是数组时只取 text 块，其余记名丢弃', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'gpt-x',
      choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }] } }],
    },
    'chat',
    'messages',
  );
  assert.equal(result.payload.content.length, 1);
  assert.equal(result.payload.content[0].text, 'a');
  assert.deepEqual(result.dropped, ['part:image_url']);
});

test('chat->messages：content 数组里没有 type 的块按 unknown 记名', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { content: [{}] } }] },
    'chat',
    'messages',
  );
  assert.deepEqual(result.dropped, ['part:unknown']);
});

test('chat->messages：工具参数不是 JSON 时记名丢弃并用空对象', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'x',
      choices: [
        {
          message: {
            tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{not json' } }],
          },
        },
      ],
    },
    'chat',
    'messages',
  );
  assert.deepEqual(result.dropped, ['tool_calls:arguments_not_json']);
  assert.deepEqual(result.payload.content[0].input, {});
});

test('chat->messages：工具参数已经是对象时直接用', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'x',
      choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'f', arguments: { a: 1 } } }] } }],
    },
    'chat',
    'messages',
  );
  assert.deepEqual(result.payload.content[0].input, { a: 1 });
  assert.deepEqual(result.dropped, []);
});

test('chat->messages：工具调用没有 arguments 时用空对象', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'f' } }] } }] },
    'chat',
    'messages',
  );
  assert.deepEqual(result.payload.content[0].input, {});
});

test('chat->messages：finish_reason 各种取值都映射到 stop_reason', () => {
  const cases = [
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'refusal'],
    ['weird', 'end_turn'],
  ];
  for (const [finishReason, stopReason] of cases) {
    const result = convertResponseJson(
      { id: 'c', model: 'x', choices: [{ message: { content: 't' }, finish_reason: finishReason }] },
      'chat',
      'messages',
    );
    assert.equal(result.payload.stop_reason, stopReason, `finish_reason=${finishReason}`);
  }
});

test('chat->messages：usage 缺失时 token 数是 0', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { content: 't' } }] },
    'chat',
    'messages',
  );
  assert.deepEqual(result.payload.usage, { input_tokens: 0, output_tokens: 0 });
});

test('chat->messages：choices 为空数组时也能转换', () => {
  const result = convertResponseJson({ id: 'c', model: 'x', choices: [] }, 'chat', 'messages');
  assert.equal(result.payload.stop_reason, 'end_turn');
  // 没有内容时兜底给一个空 text 块，客户端不会看到空的 content 数组
  assert.deepEqual(result.payload.content, [{ type: 'text', text: '' }]);
});

// ---------------------------------------------------------------- responses → chat

test('responses->chat：message 里的非 output_text 部件记名丢弃', () => {
  const result = convertResponseJson(
    {
      id: 'r',
      model: 'gpt-x',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'hi' }] }],
    },
    'responses',
    'chat',
  );
  assert.deepEqual(result.dropped, ['part:refusal']);
  assert.equal(result.payload.choices[0].message.content, 'hi');
});

test('responses->chat：reasoning 项记名丢弃', () => {
  const result = convertResponseJson(
    { id: 'r', model: 'x', output: [{ type: 'reasoning', summary: [] }] },
    'responses',
    'chat',
  );
  assert.deepEqual(result.dropped, ['reasoning:item']);
});

test('responses->chat：未知类型的输出项记名丢弃', () => {
  const result = convertResponseJson(
    { id: 'r', model: 'x', output: [{ type: 'web_search_call' }] },
    'responses',
    'chat',
  );
  assert.deepEqual(result.dropped, ['item:web_search_call']);
});

test('responses->chat：输出项没有 type 时按 unknown 记名', () => {
  const result = convertResponseJson({ id: 'r', model: 'x', output: [{}] }, 'responses', 'chat');
  assert.deepEqual(result.dropped, ['item:unknown']);
});

test('responses->chat：usage 用 prompt_tokens 兜底', () => {
  const result = convertResponseJson(
    { id: 'r', model: 'x', output: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    'responses',
    'chat',
  );
  assert.equal(result.payload.usage.prompt_tokens, 12);
  assert.equal(result.payload.usage.completion_tokens, 3);
});

test('responses->chat：incomplete 且原因是 max_output_tokens 时映射成 length', () => {
  const result = convertResponseJson(
    {
      id: 'r',
      model: 'x',
      output: [],
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    },
    'responses',
    'chat',
  );
  assert.equal(result.payload.choices[0].finish_reason, 'length');
});

test('responses->chat：incomplete 但原因是别的时不映射成 length', () => {
  const result = convertResponseJson(
    {
      id: 'r',
      model: 'x',
      output: [],
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
    },
    'responses',
    'chat',
  );
  assert.equal(result.payload.choices[0].finish_reason, 'stop');
});

// ---------------------------------------------------------------- chat → responses

test('chat->responses：工具调用进 output 数组', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'gpt-x',
      choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    },
    'chat',
    'responses',
  );
  assert.equal(result.payload.output[0].type, 'function_call');
  assert.equal(result.payload.output[0].call_id, 't1');
  assert.equal(result.payload.output[0].arguments, '{"a":1}');
});

test('chat->responses：工具调用缺 arguments 时给空对象', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { tool_calls: [{ id: 't1', function: { name: 'f' } }] } }] },
    'chat',
    'responses',
  );
  assert.equal(result.payload.output[0].arguments, '{}');
});

test('chat->responses：usage 缺失时 token 数是 0', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { content: 't' } }] },
    'chat',
    'responses',
  );
  assert.deepEqual(result.payload.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
});

// ---------------------------------------------------------------- gemini → chat

test('gemini->chat：文本与函数调用都转，函数调用时 finish_reason 是 tool_calls', () => {
  const result = convertResponseJson(
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello' }, { functionCall: { name: 'f', args: { a: 1 } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
      modelVersion: 'gemini-x',
    },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.choices[0].message.content, 'hello');
  assert.equal(result.payload.choices[0].message.tool_calls.length, 1);
  assert.equal(result.payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.payload.usage.total_tokens, 12);
  assert.equal(result.payload.model, 'gemini-x');
});

test('gemini->chat：函数调用缺 args 时给空对象', () => {
  const result = convertResponseJson(
    { candidates: [{ content: { parts: [{ functionCall: { name: 'f' } }] } }] },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.choices[0].message.tool_calls[0].function.arguments, '{}');
});

test('gemini->chat：finishReason 各值都映射到 finish_reason', () => {
  const cases = [
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['OTHER', 'stop'],
    ['WHATEVER', 'stop'],
  ];
  for (const [finishReason, expected] of cases) {
    const result = convertResponseJson(
      { candidates: [{ content: { parts: [{ text: 't' }] }, finishReason }] },
      'gemini',
      'chat',
    );
    assert.equal(result.payload.choices[0].finish_reason, expected, `finishReason=${finishReason}`);
  }
});

test('gemini->chat：认不出的 part 记名丢弃', () => {
  const result = convertResponseJson(
    { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png' } }] } }] },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.dropped, ['part:inlineData']);
});

test('gemini->chat：空 part 整块丢掉且不记名', () => {
  const result = convertResponseJson(
    { candidates: [{ content: { parts: [null] } }] },
    'gemini',
    'chat',
  );
  // null part 没有任何信息可记名，只是不该崩
  assert.deepEqual(result.dropped, []);
});

test('gemini->chat：usageMetadata 缺失时 token 数是 0', () => {
  const result = convertResponseJson(
    { candidates: [{ content: { parts: [{ text: 't' }] } }] },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.payload.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('gemini->chat：responseId 优先于 id', () => {
  const result = convertResponseJson(
    { id: 'plain', responseId: 'resp-1', candidates: [{ content: { parts: [{ text: 't' }] } }] },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.id, 'resp-1');
});

test('gemini->chat：没有 responseId 时用 id', () => {
  const result = convertResponseJson(
    { id: 'plain', candidates: [{ content: { parts: [{ text: 't' }] } }] },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.id, 'plain');
});

// ---------------------------------------------------------------- chat → gemini

test('chat->gemini：文本与函数调用都转', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'gpt-x',
      choices: [{ message: { content: 'hi', tool_calls: [{ id: 't', function: { name: 'f', arguments: '{"a":1}' } }] } }],
    },
    'chat',
    'gemini',
  );
  assert.equal(result.payload.candidates[0].content.parts[0].text, 'hi');
  assert.deepEqual(result.payload.candidates[0].content.parts[1].functionCall.args, { a: 1 });
  assert.equal(result.payload.candidates[0].finishReason, 'STOP');
  assert.equal(result.payload.modelVersion, 'gpt-x');
});

test('chat->gemini：工具参数不是 JSON 时记名丢弃并用空对象', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'x',
      choices: [{ message: { tool_calls: [{ id: 't', function: { name: 'f', arguments: 'oops' } }] } }],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.dropped, ['tool_calls:arguments_not_json']);
  assert.deepEqual(result.payload.candidates[0].content.parts[0].functionCall.args, {});
});

test('chat->gemini：工具参数已经是对象时直接用', () => {
  const result = convertResponseJson(
    {
      id: 'c',
      model: 'x',
      choices: [{ message: { tool_calls: [{ id: 't', function: { name: 'f', arguments: { a: 2 } } }] } }],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.payload.candidates[0].content.parts[0].functionCall.args, { a: 2 });
});

test('chat->gemini：工具调用缺 name 时给空字符串', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { tool_calls: [{ id: 't', function: {} }] } }] },
    'chat',
    'gemini',
  );
  assert.equal(result.payload.candidates[0].content.parts[0].functionCall.name, '');
});

test('chat->gemini：finish_reason 各值都映射到 finishReason', () => {
  const cases = [
    ['stop', 'STOP'],
    ['length', 'MAX_TOKENS'],
    ['tool_calls', 'STOP'],
    ['function_call', 'STOP'],
    ['content_filter', 'SAFETY'],
    ['whatever', 'STOP'],
  ];
  for (const [finishReason, expected] of cases) {
    const result = convertResponseJson(
      { id: 'c', model: 'x', choices: [{ message: { content: 't' }, finish_reason: finishReason }] },
      'chat',
      'gemini',
    );
    assert.equal(result.payload.candidates[0].finishReason, expected, `finish_reason=${finishReason}`);
  }
});

test('chat->gemini：没有内容时给一个空 text part', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: {} }] },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.payload.candidates[0].content.parts, [{ text: '' }]);
});

test('chat->gemini：usage 缺失时 token 数是 0', () => {
  const result = convertResponseJson(
    { id: 'c', model: 'x', choices: [{ message: { content: 't' } }] },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.payload.usageMetadata, {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
  });
});

// ---------------------------------------------------------------- 注册表与兜底

test('注册表列出十二个方向', () => {
  const names = listResponseConverters();
  assert.equal(names.length, 12);
  for (const expected of [
    'messages->chat',
    'chat->messages',
    'responses->chat',
    'chat->responses',
    'gemini->chat',
    'chat->gemini',
    'messages->responses',
    'responses->messages',
    'messages->gemini',
    'gemini->messages',
    'responses->gemini',
    'gemini->responses',
  ]) {
    assert.ok(names.includes(expected), `缺 ${expected}`);
  }
});

test('经 chat 中转时两段的丢弃项合并上报', () => {
  // responses→messages = responses→chat → chat→messages，两段都可能丢东西：
  // 第一段丢 reasoning 条目，第二段读到非 JSON 的工具参数再丢一次。
  const result = convertResponseJson(
    {
      id: 'resp_1',
      model: 'x',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: 'not json at all' },
      ],
    },
    'responses',
    'messages',
  );
  assert.equal(result.via, 'chat');
  // 第一段的丢弃项
  assert.ok(result.dropped.includes('reasoning:item'), `缺 reasoning:item：${result.dropped}`);
  // 第二段的丢弃项
  assert.ok(result.dropped.includes('tool_calls:arguments_not_json'), `缺 tool_calls:arguments_not_json：${result.dropped}`);
});

test('经 chat 中转时只有第一段产生丢弃项时也照常上报', () => {
  // messages→responses = messages→chat → chat→responses。
  // 第二段（chat→responses）不会丢东西，丢弃项全部来自第一段。
  const result = convertResponseJson(
    {
      id: 'm',
      model: 'x',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 't', name: 'f', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
    },
    'messages',
    'responses',
  );
  assert.equal(result.via, 'chat');
  assert.deepEqual(result.dropped, ['thinking:block']);
  // messages→chat 会把 input 序列化成合法 JSON，第二段因此不再丢工具参数
  const call = result.payload.output.find((item) => item.type === 'function_call');
  assert.equal(call.arguments, '{"a":1}');
});

test('不认识的协议方向不转换', () => {
  const payload = { id: 'x' };
  const result = convertResponseJson(payload, 'messages', 'gemini2');
  assert.equal(result.changed, false);
  assert.equal(result.payload, payload);
  assert.deepEqual(result.dropped, []);
});

test('payload 为 null 或非对象时不转换', () => {
  assert.equal(convertResponseJson(null, 'messages', 'chat').changed, false);
  assert.equal(convertResponseJson('a string', 'messages', 'chat').changed, false);
});
