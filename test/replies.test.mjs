import assert from 'node:assert/strict';
import test from 'node:test';

import { convertResponseJson, listResponseConverters } from '../src/replies.js';

// ---------------------------------------------------------------- messages -> chat

test('messagesJsonToChat：文本块回填、stop_reason 与 usage 映射', () => {
  const { payload, dropped } = convertResponseJson(
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'glm-5.3',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    },
    'messages',
    'chat',
  );

  assert.deepEqual(dropped, []);
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.choices[0].message.content, 'hello');
  assert.equal(payload.choices[0].finish_reason, 'length');
  assert.deepEqual(payload.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cache_read_input_tokens: 3,
  });
});

test('messagesJsonToChat：tool_use 回成 tool_calls，thinking 块记名丢弃', () => {
  const { payload, dropped } = convertResponseJson(
    {
      id: 'msg_2',
      model: 'glm-5.3',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'sz' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    'messages',
    'chat',
  );

  assert.ok(dropped.includes('thinking:block'));
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(payload.choices[0].message.content, null);
  assert.deepEqual(payload.choices[0].message.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sz"}' } },
  ]);
});

// ---------------------------------------------------------------- chat -> messages

test('chatJsonToMessages：空内容也保证有非空的 content 数组', () => {
  const empty = convertResponseJson(
    { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }], usage: {} },
    'chat',
    'messages',
  );
  assert.deepEqual(empty.payload.content, [{ type: 'text', text: '' }]);
  assert.equal(empty.payload.stop_reason, 'end_turn');

  const withTools = convertResponseJson(
    {
      id: 'c2',
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: 'not-json' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 6 },
    },
    'chat',
    'messages',
  );
  assert.deepEqual(withTools.payload.content, [
    { type: 'tool_use', id: 'call_1', name: 'f', input: {} },
  ]);
  assert.ok(withTools.dropped.includes('tool_calls:arguments_not_json'));
  assert.equal(withTools.payload.stop_reason, 'tool_use');
  assert.deepEqual(withTools.payload.usage, { input_tokens: 4, output_tokens: 6 });
});

// ---------------------------------------------------------------- responses -> chat

test('responsesJsonToChat：output 数组拼回一条 assistant 消息，截断映射成 length', () => {
  const { payload } = convertResponseJson(
    {
      id: 'r1',
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      model: 'glm-5.3',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
      ],
      usage: { input_tokens: 8, output_tokens: 9 },
    },
    'responses',
    'chat',
  );

  assert.equal(payload.choices[0].finish_reason, 'length');
  assert.equal(payload.choices[0].message.content, 'partial');
  assert.deepEqual(payload.usage, { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 });
});

test('responsesJsonToChat：function_call 决定 finish_reason=tool_calls', () => {
  const { payload } = convertResponseJson(
    {
      id: 'r2',
      model: 'm',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    'responses',
    'chat',
  );
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(payload.choices[0].message.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
  ]);
});

// ---------------------------------------------------------------- chat -> responses

test('chatJsonToResponses：文本与 tool_calls 进 output 数组，空输出也兜底', () => {
  const text = convertResponseJson(
    { id: 'c1', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    'chat',
    'responses',
  );
  assert.equal(text.payload.object, 'response');
  assert.equal(text.payload.status, 'completed');
  assert.deepEqual(text.payload.output, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  ]);
  assert.deepEqual(text.payload.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });

  const empty = convertResponseJson(
    { id: 'c2', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }], usage: {} },
    'chat',
    'responses',
  );
  assert.deepEqual(empty.payload.output, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
  ]);
});

// ---------------------------------------------------------------- 组合与边界

test('messages->responses 经 chat 中转并标注 via', () => {
  const result = convertResponseJson(
    {
      id: 'msg_1',
      model: 'm',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
    },
    'messages',
    'responses',
  );
  assert.equal(result.via, 'chat');
  assert.equal(result.payload.object, 'response');
  assert.deepEqual(result.payload.output[0].content, [{ type: 'output_text', text: 'hi' }]);
});

test('同协议或非法 payload 不转换', () => {
  const payload = { id: 'x' };
  assert.deepEqual(convertResponseJson(payload, 'chat', 'chat'), {
    payload,
    changed: false,
    dropped: [],
    via: null,
  });
  assert.equal(convertResponseJson(null, 'messages', 'chat').changed, false);
  assert.equal(convertResponseJson('text', 'messages', 'chat').changed, false);
});

test('注册表覆盖全部六个方向', () => {
  assert.deepEqual(listResponseConverters().sort(), [
    'chat->messages',
    'chat->responses',
    'messages->chat',
    'messages->responses',
    'responses->chat',
    'responses->messages',
  ]);
});
