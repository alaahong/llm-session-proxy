import assert from 'node:assert/strict';
import test from 'node:test';

import { convertRequestBody, describeConverters, isConverter, listConverters } from '../src/converters.js';

// ---------------------------------------------------------------- chat -> messages

test('chat->messages：system 归位、必填 max_tokens 补默认、stop 换名', () => {
  const result = convertRequestBody(
    {
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      stop: ['END', 'STOP'],
      temperature: 0.5,
    },
    'chat',
    'messages',
  );

  assert.equal(result.changed, true);
  assert.ok(result.changes.includes('system:moved'));
  assert.ok(result.changes.includes('max_tokens:default(4096)'));
  assert.ok(result.changes.includes('stop->stop_sequences'));
  assert.equal(result.body.system, 'be brief');
  assert.equal(result.body.max_tokens, 4096);
  assert.deepEqual(result.body.stop_sequences, ['END', 'STOP']);
  assert.equal(result.body.temperature, 0.5);
  assert.deepEqual(result.body.messages, [{ role: 'user', content: 'hi' }]);
  // 返回新对象，原 body 不被改动
  assert.ok(!('max_tokens' in (result.body.messages[0] || {})));
});

test('chat->messages：max_tokens 与 max_completion_tokens 都被认', () => {
  const a = convertRequestBody({ model: 'm', messages: [], max_tokens: 123 }, 'chat', 'messages');
  assert.equal(a.body.max_tokens, 123);
  assert.deepEqual(a.changes, []);

  const b = convertRequestBody({ model: 'm', messages: [], max_completion_tokens: 456 }, 'chat', 'messages');
  assert.equal(b.body.max_tokens, 456);
});

test('chat->messages：工具与 tool 消息的形状转换', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sz"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '26C' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    },
    'chat',
    'messages',
  );

  assert.ok(result.changes.includes('tools:flattened'));
  assert.ok(result.changes.includes('tool_calls->tool_use'));
  assert.ok(result.changes.includes('tool:message->tool_result'));
  assert.deepEqual(result.body.tools, [
    { name: 'get_weather', description: 'w', input_schema: { type: 'object' } },
  ]);
  assert.deepEqual(result.body.tool_choice, { type: 'auto' });
  assert.deepEqual(result.body.messages[1].content, [
    { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'sz' } },
  ]);
  assert.deepEqual(result.body.messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '26C' }],
  });
});

test('chat->messages：reasoning_effort 按固定表换算成 thinking 预算', () => {
  const low = convertRequestBody({ model: 'm', messages: [], reasoning_effort: 'low' }, 'chat', 'messages');
  assert.equal(low.body.thinking.budget_tokens, 1024);
  const high = convertRequestBody({ model: 'm', messages: [], reasoning_effort: 'high' }, 'chat', 'messages');
  assert.equal(high.body.thinking.budget_tokens, 16384);
  const bad = convertRequestBody({ model: 'm', messages: [], reasoning_effort: 'ultra' }, 'chat', 'messages');
  assert.ok(bad.dropped.includes('reasoning_effort:ultra'));
});

test('chat->messages：chat 独有字段逐个记名丢弃，分段内容与图片不丢', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'audio', audio: 'x' },
          ],
        },
      ],
      seed: 42,
      response_format: { type: 'json_object' },
    },
    'chat',
    'messages',
  );

  assert.ok(result.dropped.includes('seed'));
  assert.ok(result.dropped.includes('response_format'));
  assert.ok(result.dropped.includes('part:audio'));
  assert.deepEqual(result.body.messages[0].content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
  ]);
});

// ---------------------------------------------------------------- messages -> chat

test('messages->chat：system 下放成消息、工具嵌套回去、stop 换名', () => {
  const result = convertRequestBody(
    {
      model: 'glm-5.3',
      system: 'be brief',
      max_tokens: 2048,
      stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    },
    'messages',
    'chat',
  );

  assert.ok(result.changes.includes('system:moved'));
  assert.ok(result.changes.includes('stop_sequences->stop'));
  assert.equal(result.body.max_tokens, 2048);
  assert.deepEqual(result.body.stop, ['END']);
  assert.equal(result.body.temperature, 0.7);
  assert.deepEqual(result.body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ]);
});

test('messages->chat：tool_use/tool_result 回到 tool_calls 与 role:tool', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'sz' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '26C' }] },
      ],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    },
    'messages',
    'chat',
  );

  assert.ok(result.changes.includes('tool_use->tool_calls'));
  assert.ok(result.changes.includes('tool_result->tool:message'));
  assert.ok(result.changes.includes('tools:nested'));
  assert.deepEqual(result.body.tools, [
    { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } },
  ]);
  assert.equal(result.body.tool_choice, 'required');
  const assistant = result.body.messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sz"}' } },
  ]);
  assert.deepEqual(result.body.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '26C' });
});

test('messages->chat：thinking 预算反推回 reasoning_effort，thinking 块记名丢弃', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      thinking: { type: 'enabled', budget_tokens: 8192 },
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    },
    'messages',
    'chat',
  );

  assert.ok(result.changes.includes('thinking->reasoning_effort(medium)'));
  assert.equal(result.body.reasoning_effort, 'medium');
  assert.ok(result.dropped.includes('thinking:block'));
  assert.equal(result.body.messages[0].content, 'answer');
});

test('messages->chat：base64 图片转回 data URL', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } }] }],
    },
    'messages',
    'chat',
  );
  assert.deepEqual(result.body.messages[0].content, [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
  ]);
});

// ---------------------------------------------------------------- chat <-> responses

test('chat->responses：max_tokens 换名、instructions 归位、工具扁平化', () => {
  const result = convertRequestBody(
    {
      model: 'glm-5.3',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 777,
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
    },
    'chat',
    'responses',
  );

  assert.equal(result.body.max_output_tokens, 777);
  assert.deepEqual(result.body.reasoning, { effort: 'high' });
  assert.equal(result.body.instructions, 'be brief');
  assert.ok(result.changes.includes('tools:flattened'));
  assert.deepEqual(result.body.tools, [{ type: 'function', name: 'f', description: undefined, parameters: { type: 'object' } }]);
  assert.deepEqual(result.body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ]);
});

test('responses->chat：input 条目回到消息，function_call 聚到 tool_calls', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      instructions: 'be brief',
      max_output_tokens: 777,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"sz"}' },
        { type: 'function_call_output', call_id: 'c1', output: '26C' },
        { type: 'reasoning', summary: [] },
      ],
      reasoning: { effort: 'low' },
    },
    'responses',
    'chat',
  );

  assert.ok(result.changes.includes('system:moved'));
  assert.ok(result.changes.includes('function_call->tool_calls'));
  assert.ok(result.changes.includes('function_call_output->tool:message'));
  assert.ok(result.dropped.includes('reasoning:item'));
  assert.equal(result.body.max_tokens, 777);
  assert.equal(result.body.reasoning_effort, 'low');
  assert.equal(result.body.messages[0].content, 'be brief');
  assert.deepEqual(result.body.messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sz"}' } }],
  });
  assert.deepEqual(result.body.messages[3], { role: 'tool', tool_call_id: 'c1', content: '26C' });
});

// ---------------------------------------------------------------- 组合与边界

test('messages->responses 经 chat 中转，changes 按序拼接并标注 via', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      system: 'sys',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    },
    'messages',
    'responses',
  );

  assert.equal(result.via, 'chat');
  // 两段各报一次 system:moved：messages->chat 与 chat->responses
  assert.equal(result.changes.filter((tag) => tag === 'system:moved').length, 2);
  // system 应该最终落在 responses 的 instructions 上
  assert.equal(result.body.instructions, 'sys');
  assert.equal(result.body.max_output_tokens, 100);
  assert.deepEqual(result.body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
});

test('同协议或非法输入不转换，原样返回', () => {
  const body = { model: 'm' };
  assert.deepEqual(convertRequestBody(body, 'chat', 'chat'), { body, changed: false, changes: [], dropped: [], via: null });
  assert.deepEqual(convertRequestBody(null, 'chat', 'messages').changed, false);
  assert.deepEqual(convertRequestBody('str', 'chat', 'messages').changed, false);
});

test('注册表：四个直达对 + 两个经 chat 中转的对', () => {
  assert.deepEqual(listConverters().sort(), [
    'chat->messages',
    'chat->responses',
    'messages->chat',
    'messages->responses',
    'responses->chat',
    'responses->messages',
  ]);
  assert.equal(isConverter('chat->messages'), true);
  assert.equal(isConverter('chat->nope'), false);
  const described = describeConverters();
  const composed = described.find((item) => item.name === 'messages->responses');
  assert.equal(composed.direct, false);
  assert.equal(composed.via, 'messages->chat then chat->responses');
});
