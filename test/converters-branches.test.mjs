import assert from 'node:assert/strict';
import test from 'node:test';

import {
  convertRequestBody,
  describeConverters,
  isConverter,
  listConverters,
} from '../src/converters.js';

/**
 * 请求体互转的分支覆盖。
 *
 * converters.test.mjs 覆盖的是「主干形状对不对」，这里补的是**边缘分支**：
 * 字段缺失、类型不对、协议里没有对应物、工具参数不是 JSON、
 * 以及「转换器自己都说不清」的那些角落。
 *
 * 判据统一：转换器要么把字段映射对，要么把丢掉的字段**记名**报出来。
 * 「静默丢掉」是这个项目最忌讳的行为。
 */

// ---------------------------------------------------------------- 辅助

function convert(body, from, to) {
  return convertRequestBody(body, from, to);
}

/** 一条带工具调用的 assistant 消息——工具参数的形态随测随换。 */
function assistantToolCall(arguments_) {
  return {
    model: 'm',
    messages: [
      {
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: arguments_ } }],
      },
    ],
  };
}

// ---------------------------------------------------------------- chat → messages

test('chat->messages：max_tokens 走 max_completion_tokens 兜底', () => {
  const result = convert({ model: 'm', max_completion_tokens: 256, messages: [] }, 'chat', 'messages');
  assert.equal(result.body.max_tokens, 256);
});

test('chat->messages：tool_choice=none 时把工具一并丢掉并记名', () => {
  const result = convert(
    {
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'none',
    },
    'chat',
    'messages',
  );
  assert.equal(result.body.tools, undefined);
  assert.ok(result.changes.includes('tool_choice:none->tools_dropped'));
});

test('chat->messages：tool_choice 是 {function:{name}} 时映射成 type:tool', () => {
  const result = convert(
    { model: 'm', messages: [], tool_choice: { type: 'function', function: { name: 'search' } } },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.tool_choice, { type: 'tool', name: 'search' });
});

test('chat->messages：tool_choice 是 {type:"tool"} 时原样带过去', () => {
  const result = convert(
    { model: 'm', messages: [], tool_choice: { type: 'tool', name: 'search' } },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.tool_choice, { type: 'tool', name: 'search' });
});

test('chat->messages：tool_choice 是不认识的对象时不产出 tool_choice', () => {
  const result = convert(
    { model: 'm', messages: [], tool_choice: { type: 'weird' } },
    'chat',
    'messages',
  );
  assert.equal(result.body.tool_choice, undefined);
});

test('chat->messages：assistant 的工具参数不是 JSON 时给空对象并记名', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'not json' } }],
        },
      ],
    },
    'chat',
    'messages',
  );
  const block = result.body.messages[0].content[0];
  assert.equal(block.type, 'tool_use');
  assert.deepEqual(block.input, {});
  // 静默丢掉是这个项目最忌讳的行为——必须记名
  assert.ok(result.dropped.includes('tool_calls:arguments_not_json'));
});

test('chat->messages：assistant 的工具参数缺 arguments 时也给空对象', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f' } }] },
      ],
    },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.messages[0].content[0].input, {});
});

test('chat->messages：工具声明没有 parameters 时补空 object schema', () => {
  const result = convert(
    { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'f' } }] },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.tools[0].input_schema, { type: 'object' });
});

test('chat->messages：tool 消息的内容是分段数组时取纯文本', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: '26' }] },
      ],
    },
    'chat',
    'messages',
  );
  assert.equal(result.body.messages[0].content[0].content, '26');
});

test('chat->messages：内容里不认识的 part 记名丢弃', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] },
    'chat',
    'messages',
  );
  assert.ok(result.dropped.includes('part:audio'));
});

test('chat->messages：内容数组里没有 text 也没有图片时给空串', () => {
  const result = convert({ model: 'm', messages: [{ role: 'user', content: [] }] }, 'chat', 'messages');
  assert.equal(result.body.messages[0].content, '');
});

test('chat->messages：reasoning_effort 不在固定表里时记名丢弃', () => {
  const result = convert(
    { model: 'm', messages: [], reasoning_effort: 'extreme' },
    'chat',
    'messages',
  );
  assert.ok(result.dropped.includes('reasoning_effort:extreme'));
  assert.equal(result.body.thinking, undefined);
});

test('chat->messages：stop 是单个字符串时也认', () => {
  const result = convert({ model: 'm', messages: [], stop: 'END' }, 'chat', 'messages');
  assert.deepEqual(result.body.stop_sequences, ['END']);
});

// ---------------------------------------------------------------- messages → chat

test('messages->chat：system 是分段数组时拼成一段文本', () => {
  const result = convert(
    { model: 'm', system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [] },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].content, 'a\nb');
});

test('messages->chat：system 是分段数组且元素是字符串时也认', () => {
  const result = convert({ model: 'm', system: ['a', 'b'], messages: [] }, 'messages', 'chat');
  assert.equal(result.body.messages[0].content, 'a\nb');
});

test('messages->chat：system 不是字符串也不是数组时忽略', () => {
  const result = convert({ model: 'm', system: 42, messages: [] }, 'messages', 'chat');
  assert.equal(result.body.messages.length, 0);
});

test('messages->chat：thinking 块的预算不是数字时按 medium 反推', () => {
  const result = convert(
    { model: 'm', thinking: { type: 'enabled', budget_tokens: 'lots' }, messages: [] },
    'messages',
    'chat',
  );
  assert.equal(result.body.reasoning_effort, 'medium');
});

test('messages->chat：thinking 预算低于 4096 时反推成 low', () => {
  const result = convert(
    { model: 'm', thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [] },
    'messages',
    'chat',
  );
  assert.equal(result.body.reasoning_effort, 'low');
  assert.ok(result.changes.includes('thinking->reasoning_effort(low)'));
});

test('messages->chat：不认识的块类型记名丢弃', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] },
    'messages',
    'chat',
  );
  assert.ok(result.dropped.includes('block:audio'));
});

test('messages->chat：tool_result 的内容是分段数组时取纯文本', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
      ],
    },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].role, 'tool');
  assert.equal(result.body.messages[0].content, 'ok');
});

test('messages->chat：tool_result 的内容既不是字符串也不是数组时给空串', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 42 }] }],
    },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '');
});

test('messages->chat：图片块没有 source 时给空 url', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'image' }] }] },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].content[0].image_url.url, '');
});

test('messages->chat：base64 图片缺 media_type 时补 image/png', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAA' } }] }],
    },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].content[0].image_url.url, 'data:image/png;base64,AAA');
});

test('messages->chat：tool_choice 是 {type:"tool",name} 时映射成 chat 形状', () => {
  const result = convert(
    { model: 'm', messages: [], tool_choice: { type: 'tool', name: 'search' } },
    'messages',
    'chat',
  );
  assert.deepEqual(result.body.tool_choice, { type: 'function', function: { name: 'search' } });
});

test('messages->chat：工具声明没有 input_schema 时补空 object schema', () => {
  const result = convert({ model: 'm', messages: [], tools: [{ name: 'f' }] }, 'messages', 'chat');
  assert.deepEqual(result.body.tools[0].function.parameters, { type: 'object' });
});

test('messages->chat：metadata 与 service_tier 记名丢弃', () => {
  const result = convert(
    { model: 'm', messages: [], metadata: { a: 1 }, service_tier: 'flex' },
    'messages',
    'chat',
  );
  assert.ok(result.dropped.includes('metadata'));
  assert.ok(result.dropped.includes('service_tier'));
});

test('messages->chat：stop_sequences 是空数组时不认', () => {
  const result = convert({ model: 'm', messages: [], stop_sequences: [] }, 'messages', 'chat');
  assert.equal(result.body.stop, undefined);
  assert.equal(result.changes.includes('stop_sequences->stop'), false);
});

// ---------------------------------------------------------------- chat → responses

test('chat->responses：tool 消息变成 function_call_output', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'tool', tool_call_id: 'c1', content: '26' }] },
    'chat',
    'responses',
  );
  assert.deepEqual(result.body.input[0], { type: 'function_call_output', call_id: 'c1', output: '26' });
  assert.ok(result.changes.includes('tool:message->function_call_output'));
});

test('chat->responses：assistant 的工具调用变成 function_call 条目', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: 'hi',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
        },
      ],
    },
    'chat',
    'responses',
  );
  assert.equal(result.body.input[0].type, 'message');
  assert.deepEqual(result.body.input[1], {
    type: 'function_call',
    call_id: 'c1',
    name: 'f',
    arguments: '{"a":1}',
  });
  assert.ok(result.changes.includes('tool_calls->function_call'));
});

test('chat->responses：assistant 的工具调用缺 arguments 时补 {}', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f' } }] }],
    },
    'chat',
    'responses',
  );
  assert.equal(result.body.input[0].arguments, '{}');
});

test('chat->responses：图片变成 input_image', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }],
    },
    'chat',
    'responses',
  );
  assert.deepEqual(result.body.input[0].content[0], { type: 'input_image', image_url: 'https://x/a.png' });
});

test('chat->responses：stop 没有等价物，记名丢弃', () => {
  const result = convert({ model: 'm', messages: [], stop: 'END' }, 'chat', 'responses');
  assert.ok(result.dropped.includes('stop'));
});

test('chat->responses：tool_choice 是 {function:{name}} 时映射成扁平形状', () => {
  const result = convert(
    { model: 'm', messages: [], tool_choice: { type: 'function', function: { name: 'f' } } },
    'chat',
    'responses',
  );
  assert.deepEqual(result.body.tool_choice, { type: 'function', name: 'f' });
});

test('chat->responses：store 不算丢弃项（responses 原生有）', () => {
  const result = convert({ model: 'm', messages: [], store: true }, 'chat', 'responses');
  assert.equal(result.dropped.includes('store'), false);
});

// ---------------------------------------------------------------- responses → chat

test('responses->chat：tools 变回嵌套形状', () => {
  const result = convert(
    { model: 'm', input: [], tools: [{ type: 'function', name: 'f', description: 'd' }] },
    'responses',
    'chat',
  );
  assert.equal(result.body.tools[0].type, 'function');
  assert.equal(result.body.tools[0].function.name, 'f');
  assert.ok(result.changes.includes('tools:nested'));
});

test('responses->chat：非 function 类型的工具被过滤掉', () => {
  const result = convert(
    { model: 'm', input: [], tools: [{ type: 'web_search' }] },
    'responses',
    'chat',
  );
  assert.deepEqual(result.body.tools, []);
});

test('responses->chat：input 是字符串时当一条 user 消息', () => {
  const result = convert({ model: 'm', input: ['hello'] }, 'responses', 'chat');
  assert.deepEqual(result.body.messages[0], { role: 'user', content: 'hello' });
});

test('responses->chat：input 条目类型不认识时记名丢弃', () => {
  const result = convert({ model: 'm', input: [{ type: 'weird' }] }, 'responses', 'chat');
  assert.ok(result.dropped.includes('item:weird'));
});

test('responses->chat：function_call_output 的输出不是字符串时序列化', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'c1', output: { ok: true } }] },
    'responses',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '{"ok":true}');
});

test('responses->chat：function_call_output 的输出缺省时给空串', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'c1' }] },
    'responses',
    'chat',
  );
  // 缺 output 时是**空内容**，不是 JSON 编码后的 `""`（那两个字面引号会被当成内容）
  assert.equal(result.body.messages[0].content, '');
});

test('responses->chat：function_call_output 的输出是 null 时也给空串', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'c1', output: null }] },
    'responses',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '');
});

test('responses->chat：reasoning 条目记名丢弃', () => {
  const result = convert({ model: 'm', input: [{ type: 'reasoning' }] }, 'responses', 'chat');
  assert.ok(result.dropped.includes('reasoning:item'));
});

test('responses->chat：input 里的消息含图片时拼成多段 content', () => {
  const result = convert(
    {
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'https://x/a.png' },
          ],
        },
      ],
    },
    'responses',
    'chat',
  );
  const content = result.body.messages[0].content;
  assert.equal(content[0].type, 'image_url');
  assert.equal(content[1].text, 'look');
});

test('responses->chat：tool_choice 是 {type:"function",name} 时映射成 chat 形状', () => {
  const result = convert(
    { model: 'm', input: [], tool_choice: { type: 'function', name: 'f' } },
    'responses',
    'chat',
  );
  assert.deepEqual(result.body.tool_choice, { type: 'function', function: { name: 'f' } });
});

test('responses->chat：truncation 等 responses 独有字段记名丢弃', () => {
  const result = convert(
    { model: 'm', input: [], truncation: 'auto', include: ['x'], text: { a: 1 } },
    'responses',
    'chat',
  );
  assert.ok(result.dropped.includes('truncation'));
  assert.ok(result.dropped.includes('include'));
  assert.ok(result.dropped.includes('text'));
});

test('responses->chat：assistant 文本与 function_call 合进同一条消息', () => {
  const result = convert(
    {
      model: 'm',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      ],
    },
    'responses',
    'chat',
  );
  // 一轮输出就是**一条** assistant 消息：content 与 tool_calls 并存。
  // 拆成两条会改变对话结构，转 Anthropic 时角色不交替会被 400。
  assert.equal(result.body.messages.length, 1);
  assert.equal(result.body.messages[0].role, 'assistant');
  assert.equal(result.body.messages[0].content, 'hi');
  assert.equal(result.body.messages[0].tool_calls.length, 1);
});

// ---------------------------------------------------------------- chat → gemini

test('chat->gemini：tool 消息变成 functionResponse', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'tool', tool_call_id: 'c1', content: '26' }] },
    'chat',
    'gemini',
  );
  assert.equal(result.body.contents[0].role, 'user');
  assert.deepEqual(result.body.contents[0].parts[0].functionResponse, {
    name: 'c1',
    response: { content: '26' },
  });
  assert.ok(result.changes.includes('tool:message->functionResponse'));
});

test('chat->gemini：tool 消息缺 tool_call_id 时名字给空串', () => {
  const result = convert({ model: 'm', messages: [{ role: 'tool', content: '26' }] }, 'chat', 'gemini');
  assert.equal(result.body.contents[0].parts[0].functionResponse.name, '');
});

test('chat->gemini：base64 图片变 inlineData', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] }],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.body.contents[0].parts[0].inlineData, { mimeType: 'image/jpeg', data: 'AAA' });
});

test('chat->gemini：普通图片链接变 fileData', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.body.contents[0].parts[0].fileData, { fileUri: 'https://x/a.png' });
});

test('chat->gemini：内容里不认识的 part 记名丢弃', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }] },
    'chat',
    'gemini',
  );
  assert.ok(result.dropped.includes('part:audio'));
});

test('chat->gemini：空字符串内容不产生 part', () => {
  const result = convert({ model: 'm', messages: [{ role: 'user', content: '' }] }, 'chat', 'gemini');
  assert.deepEqual(result.body.contents[0].parts, []);
});

test('chat->gemini：model 字段记名「移到路径上」', () => {
  const result = convert({ model: 'gemini-2.5-pro', messages: [] }, 'chat', 'gemini');
  assert.ok(result.changes.includes('model:->path'));
  assert.equal(result.body.model, undefined);
});

test('chat->gemini：reasoning_effort 不在固定表里时记名丢弃', () => {
  const result = convert({ model: 'm', messages: [], reasoning_effort: 'extreme' }, 'chat', 'gemini');
  assert.ok(result.dropped.includes('reasoning_effort:extreme'));
});

test('chat->gemini：stop 变 stopSequences', () => {
  const result = convert({ model: 'm', messages: [], stop: 'END' }, 'chat', 'gemini');
  assert.deepEqual(result.body.generationConfig.stopSequences, ['END']);
  assert.ok(result.changes.includes('stop->stopSequences'));
});

test('chat->gemini：tool_calls 的参数不是 JSON 时给空对象并记名', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: 'nope' } }] }],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.body.contents[0].parts[0].functionCall.args, {});
  assert.ok(result.dropped.includes('tool_calls:arguments_not_json'));
});

test('chat->gemini：tool_calls 缺 name 时给空串', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: {} }] }],
    },
    'chat',
    'gemini',
  );
  assert.equal(result.body.contents[0].parts[0].functionCall.name, '');
});

test('chat->gemini：system 消息为空串时不产生 systemInstruction', () => {
  const result = convert({ model: 'm', messages: [{ role: 'system', content: '' }] }, 'chat', 'gemini');
  assert.equal(result.body.systemInstruction, undefined);
});

// ---------------------------------------------------------------- gemini → chat

test('gemini->chat：systemInstruction 变回一条 system 消息', () => {
  const result = convert(
    { systemInstruction: { parts: [{ text: 'be nice' }] }, contents: [] },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.body.messages[0], { role: 'system', content: 'be nice' });
  assert.ok(result.changes.includes('system:moved'));
});

test('gemini->chat：systemInstruction 不是对象时忽略', () => {
  const result = convert({ systemInstruction: 'hi', contents: [] }, 'gemini', 'chat');
  assert.equal(result.body.messages.length, 0);
});

test('gemini->chat：认不出的 part 记名丢弃', () => {
  const result = convert(
    { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] }] },
    'gemini',
    'chat',
  );
  assert.ok(result.dropped.includes('part:inlineData'));
});

test('gemini->chat：stopSequences 变回 stop', () => {
  const result = convert(
    { contents: [], generationConfig: { stopSequences: ['END'] } },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.body.stop, ['END']);
  assert.ok(result.changes.includes('stopSequences->stop'));
});

test('gemini->chat：functionDeclarations 变回 tools', () => {
  const result = convert(
    {
      contents: [],
      tools: [{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] }],
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.tools[0].type, 'function');
  assert.equal(result.body.tools[0].function.name, 'f');
  assert.ok(result.changes.includes('functionDeclarations->tools'));
});

test('gemini->chat：functionDeclarations 缺 parameters 时补空 object schema', () => {
  const result = convert(
    { contents: [], tools: [{ functionDeclarations: [{ name: 'f' }] }] },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.body.tools[0].function.parameters, { type: 'object' });
});

test('gemini->chat：functionResponse 的响应是字符串时直接用', () => {
  const result = convert(
    {
      contents: [
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'f', response: 'plain' } }],
        },
      ],
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].content, 'plain');
});

test('gemini->chat：functionResponse 的响应是对象时取 content', () => {
  const result = convert(
    {
      contents: [
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'f', response: { content: 'nested' } } }],
        },
      ],
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].content, 'nested');
});

test('gemini->chat：functionResponse 缺 name 时 tool_call_id 给空串', () => {
  const result = convert(
    { contents: [{ role: 'user', parts: [{ functionResponse: { response: 'x' } }] }] },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].tool_call_id, '');
});

test('gemini->chat：generationConfig 不是对象时忽略', () => {
  const result = convert({ contents: [], generationConfig: 'nope' }, 'gemini', 'chat');
  assert.equal(result.body.max_tokens, undefined);
  assert.equal(result.body.temperature, undefined);
});

test('gemini->chat：model 消息的 role 归一成 assistant', () => {
  const result = convert(
    { contents: [{ role: 'model', parts: [{ text: 'hi' }] }] },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].role, 'assistant');
});

test('gemini->chat：functionCall 缺 args 时给空对象', () => {
  const result = convert(
    { contents: [{ role: 'model', parts: [{ functionCall: { name: 'f' } }] }] },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].tool_calls[0].function.arguments, '{}');
});

test('gemini->chat：functionCall 缺 name 时给空串', () => {
  const result = convert(
    { contents: [{ role: 'model', parts: [{ functionCall: { args: {} } }] }] },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].tool_calls[0].function.name, '');
});

// ---------------------------------------------------------------- 注册表与兜底

test('注册表：列出十二个方向', () => {
  const names = listConverters();
  assert.equal(names.length, 12);
  for (const expected of [
    'chat->messages',
    'messages->chat',
    'chat->responses',
    'responses->chat',
    'chat->gemini',
    'gemini->chat',
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

test('注册表：isConverter 只认表内的名字', () => {
  assert.equal(isConverter('chat->messages'), true);
  assert.equal(isConverter('messages->gemini'), true);
  assert.equal(isConverter('chat->gemini2'), false);
  assert.equal(isConverter('toString'), false);
});

test('注册表：describeConverters 标出直达与中转', () => {
  const list = describeConverters();
  assert.equal(list.length, 12);
  const direct = list.find((item) => item.name === 'chat->messages');
  assert.equal(direct.direct, true);
  assert.equal(direct.via, null);
  const via = list.find((item) => item.name === 'messages->gemini');
  assert.equal(via.direct, false);
  assert.equal(via.via, 'messages->chat then chat->gemini');
});

test('不认识的方向不转换，原样返回', () => {
  const body = { model: 'm', messages: [] };
  const result = convertRequestBody(body, 'chat', 'gemini2');
  assert.equal(result.changed, false);
  assert.equal(result.body, body);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.via, null);
});

test('body 是 null 或非对象时不转换', () => {
  assert.equal(convertRequestBody(null, 'chat', 'messages').changed, false);
  assert.equal(convertRequestBody('a string', 'chat', 'messages').changed, false);
  assert.equal(convertRequestBody(42, 'chat', 'messages').changed, false);
});

test('经 chat 中转时两段的 changes 与 dropped 各自合并', () => {
  // responses→messages = responses→chat → chat→messages
  // 第一段丢 reasoning 条目，第二段遇到非 JSON 的工具参数再丢一次
  const result = convertRequestBody(
    {
      model: 'm',
      input: [
        { type: 'reasoning' },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: 'not json' },
      ],
    },
    'responses',
    'messages',
  );
  assert.equal(result.via, 'chat');
  assert.ok(result.changes.includes('function_call->tool_calls'));
  assert.ok(result.changes.includes('tool_calls->tool_use'));
  assert.ok(result.dropped.includes('reasoning:item'));
  assert.ok(result.dropped.includes('tool_calls:arguments_not_json'));
});

// ---------------------------------------------------------------- 工具参数的四种形态

test('工具参数已经是对象时原样透传', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { city: 'sz' } } }],
        },
      ],
    },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.messages[0].content[0].input, { city: 'sz' });
  assert.deepEqual(result.dropped, [], '对象参数不该记丢弃');
});

test('工具参数是数字/布尔等非字符串时记名丢弃', () => {
  const result = convert(assistantToolCall(42), 'chat', 'messages');
  assert.deepEqual(result.body.messages[0].content[0].input, {});
  assert.ok(result.dropped.includes('tool_calls:arguments_not_json'));
});

test('工具参数是合法 JSON 但不是对象时记名丢弃', () => {
  // JSON.parse('123') === 123、JSON.parse('"s"') === 's'：能解析，却不是对象
  for (const raw of ['123', '"just a string"', 'true']) {
    const result = convert(assistantToolCall(raw), 'chat', 'messages');
    assert.deepEqual(result.body.messages[0].content[0].input, {}, `${raw} 不该变成 input`);
    assert.ok(result.dropped.includes('tool_calls:arguments_not_json'), `${raw} 要记名`);
  }
});

// ---------------------------------------------------------------- chat → messages 的内容形态

test('chat->messages：assistant 同时有文本和工具调用时两种块都要', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: '先查一下',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ],
    },
    'chat',
    'messages',
  );
  const blocks = result.body.messages[0].content;
  assert.equal(blocks[0].type, 'text', '文本块要在最前面');
  assert.equal(blocks[1].type, 'tool_use');
});

test('chat->messages：不认识的 content 部件记名丢弃', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'video', url: 'x' }] }],
    },
    'chat',
    'messages',
  );
  assert.ok(result.dropped.includes('part:video'), `实际：${result.dropped}`);
});

test('chat->messages：没有 type 的 content 部件按 unknown 记名', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ url: 'x' }] }] },
    'chat',
    'messages',
  );
  assert.ok(result.dropped.includes('part:unknown'));
});

test('chat->messages：data URL 图片拆成 base64 source', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } }] }],
    },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.messages[0].content[0], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' },
  });
});

test('chat->messages：普通 URL 图片走 url source', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }] }],
    },
    'chat',
    'messages',
  );
  assert.deepEqual(result.body.messages[0].content[0].source, { type: 'url', url: 'https://x/a.png' });
});

test('chat->messages：tool_choice=required/any 都映射成 type:any', () => {
  for (const choice of ['required', 'any']) {
    const result = convert({ model: 'm', messages: [], tool_choice: choice }, 'chat', 'messages');
    assert.deepEqual(result.body.tool_choice, { type: 'any' }, `${choice} 要映射成 any`);
  }
});

// ---------------------------------------------------------------- messages → chat 的内容形态

test('messages->chat：system 里没有 text 的块被过滤掉', () => {
  const result = convert(
    { model: 'm', system: [{ type: 'text' }, { type: 'text', text: '有用的一段' }], messages: [] },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '有用的一段');
});

test('messages->chat：tool_use 没有 input 时参数补 {}', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f' }] }],
    },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].tool_calls[0].function.arguments, '{}');
});

test('messages->chat：没有 type 的块按 unknown 记名', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ id: 'x' }] }] },
    'messages',
    'chat',
  );
  assert.ok(result.dropped.includes('block:unknown'));
});

test('messages->chat：text 块没有 text 时贡献空串', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'text' }] }] },
    'messages',
    'chat',
  );
  // 空文本被 filter(Boolean) 掉，消息最终没有内容也没有 tool_calls，不该进输出
  assert.equal(result.body.messages.length, 0);
});

test('messages->chat：tool_result 的分段内容里没有 text 的部件被跳过', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'image' }] }] }],
    },
    'messages',
    'chat',
  );
  assert.deepEqual(result.body.messages[0], { role: 'tool', tool_call_id: 'c1', content: '' });
});

test('messages->chat：user 消息里 tool_result 与文本、图片并存时各自归位', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: '26C' },
            { type: 'text', text: '顺便看看图' },
            { type: 'image', source: { type: 'url', url: 'https://x/a.png' } },
          ],
        },
      ],
    },
    'messages',
    'chat',
  );
  assert.deepEqual(result.body.messages[0], { role: 'tool', tool_call_id: 'c1', content: '26C' });
  // 剩下的图片和文本合成一条 user 消息，纯文本时不套数组
  assert.deepEqual(result.body.messages[1], {
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }, { type: 'text', text: '顺便看看图' }],
  });
});

test('messages->chat：user 消息里 tool_result 与纯文本并存时文本不套数组', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '26C' }, { type: 'text', text: '还有话' }] }],
    },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[1].content, '还有话');
});

test('messages->chat：user 消息里图片和文本并存时合成 content 数组', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://x/a.png' } },
            { type: 'text', text: '看图' },
          ],
        },
      ],
    },
    'messages',
    'chat',
  );
  assert.deepEqual(result.body.messages[0].content, [
    { type: 'image_url', image_url: { url: 'https://x/a.png' } },
    { type: 'text', text: '看图' },
  ]);
});

test('messages->chat：base64 source 缺 data 时补成空数据', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif' } }] }],
    },
    'messages',
    'chat',
  );
  assert.equal(result.body.messages[0].content[0].image_url.url, 'data:image/gif;base64,');
});

test('messages->chat：tool_choice 是 {type:"auto"} 时映射回 auto', () => {
  const result = convert({ model: 'm', messages: [], tool_choice: { type: 'auto' } }, 'messages', 'chat');
  assert.equal(result.body.tool_choice, 'auto');
});

// ---------------------------------------------------------------- chat → responses

test('chat->responses：tool_choice 的 auto/none/required 原样透传', () => {
  for (const choice of ['auto', 'none', 'required']) {
    const result = convert({ model: 'm', messages: [], tool_choice: choice }, 'chat', 'responses');
    assert.equal(result.body.tool_choice, choice);
  }
});

test('chat->responses：chat 独有字段逐个记名丢弃，store 例外', () => {
  const result = convert(
    { model: 'm', messages: [], seed: 7, n: 2, user: 'u1', logit_bias: { a: 1 }, store: true },
    'chat',
    'responses',
  );
  for (const key of ['seed', 'n', 'user', 'logit_bias']) {
    assert.ok(result.dropped.includes(key), `${key} 要记名，实际：${result.dropped}`);
  }
  assert.equal(result.dropped.includes('store'), false);
});

test('chat->responses：stream 原样带过去', () => {
  const result = convert({ model: 'm', messages: [], stream: true }, 'chat', 'responses');
  assert.equal(result.body.stream, true);
});

test('chat->responses：多条 system 消息用空行接成 instructions', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        { role: 'system', content: '第一段' },
        { role: 'system', content: '第二段' },
        { role: 'user', content: 'hi' },
      ],
    },
    'chat',
    'responses',
  );
  assert.equal(result.body.instructions, '第一段\n\n第二段');
});

test('chat->responses：纯 assistant 文本走 output_text', () => {
  const result = convert({ model: 'm', messages: [{ role: 'assistant', content: '想' }] }, 'chat', 'responses');
  assert.deepEqual(result.body.input[0], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: '想' }],
  });
});

test('chat->responses：消息没有任何内容时给空 content 数组', () => {
  const result = convert({ model: 'm', messages: [{ role: 'user', content: [] }] }, 'chat', 'responses');
  assert.deepEqual(result.body.input[0], { type: 'message', role: 'user', content: [] });
});

// ---------------------------------------------------------------- responses → chat

test('responses->chat：tool_choice 的 auto/none/required 原样透传', () => {
  for (const choice of ['auto', 'none', 'required']) {
    const result = convert({ model: 'm', input: [], tool_choice: choice }, 'responses', 'chat');
    assert.equal(result.body.tool_choice, choice);
  }
});

test('responses->chat：function_call 跟在 assistant 消息后面时合并进同一条', () => {
  // 拆成两条 assistant 消息会改变对话结构——转 Anthropic 时角色不交替会被 400
  const result = convert(
    {
      model: 'm',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我来查' }] },
        { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"sz"}' },
      ],
    },
    'responses',
    'chat',
  );
  assert.equal(result.body.messages.length, 1, '不能多出一条 assistant');
  assert.equal(result.body.messages[0].role, 'assistant');
  assert.equal(result.body.messages[0].content, '我来查');
  assert.equal(result.body.messages[0].tool_calls.length, 1);
  assert.equal(result.body.messages[0].tool_calls[0].function.name, 'get_weather');
});

test('responses->chat：function_call 缺 arguments 时补 {}', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'function_call', call_id: 'c1', name: 'f' }] },
    'responses',
    'chat',
  );
  assert.equal(result.body.messages[0].tool_calls[0].function.arguments, '{}');
});

test('responses->chat：function_call_output 是对象时序列化成 JSON 文本', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'c1', output: { temp: 26 } }] },
    'responses',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '{"temp":26}');
});

test('responses->chat：function_call_output 是 null 时给空串', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'function_call_output', call_id: 'c1', output: null }] },
    'responses',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '');
});

test('responses->chat：不认识的 input 条目记名丢弃', () => {
  const result = convert(
    { model: 'm', input: [{ type: 'web_search_call', query: 'x' }] },
    'responses',
    'chat',
  );
  assert.ok(result.dropped.includes('item:web_search_call'));
});

test('responses->chat：没有 type 的 input 条目按 unknown 记名', () => {
  const result = convert({ model: 'm', input: [{ foo: 1 }] }, 'responses', 'chat');
  assert.ok(result.dropped.includes('item:unknown'));
});

test('responses->chat：message 条目里图片和文本并存时合成 content 数组', () => {
  const result = convert(
    {
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'https://x/a.png' },
            { type: 'input_text', text: '看图' },
          ],
        },
      ],
    },
    'responses',
    'chat',
  );
  assert.deepEqual(result.body.messages[0].content, [
    { type: 'image_url', image_url: { url: 'https://x/a.png' } },
    { type: 'text', text: '看图' },
  ]);
});

// ---------------------------------------------------------------- chat → gemini

test('chat->gemini：stream 与 chat 独有字段照常处理', () => {
  const result = convert(
    { model: 'm', messages: [], stream: true, seed: 7, user: 'u1' },
    'chat',
    'gemini',
  );
  assert.equal(result.body.stream, true);
  assert.ok(result.dropped.includes('seed'));
  assert.ok(result.dropped.includes('user'));
  assert.ok(result.changes.includes('model:->path'), 'model 要走路径，要记名');
});

test('chat->gemini：assistant 的工具调用没有附带文本时 parts 只有 functionCall', () => {
  const result = convert(
    {
      model: 'm',
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.body.contents[0], {
    role: 'model',
    parts: [{ functionCall: { name: 'f', args: {} } }],
  });
});

test('chat->gemini：扁平形状的工具没有 parameters 时补空 schema', () => {
  const result = convert({ model: 'm', messages: [], tools: [{ name: 'f' }] }, 'chat', 'gemini');
  assert.deepEqual(result.body.tools[0].functionDeclarations[0], {
    name: 'f',
    description: undefined,
    parameters: { type: 'object' },
  });
});

test('chat->gemini：data URL 图片走 inlineData，普通 URL 走 fileData', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://x/a.png' } },
          ],
        },
      ],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.body.contents[0].parts, [
    { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    { fileData: { fileUri: 'https://x/a.png' } },
  ]);
});

// ---------------------------------------------------------------- gemini → chat

test('gemini->chat：generationConfig.topP 映射成 top_p', () => {
  const result = convert(
    { contents: [], generationConfig: { topP: 0.5 } },
    'gemini',
    'chat',
  );
  assert.equal(result.body.top_p, 0.5);
});

test('gemini->chat：functionResponse 的载荷是对象时取 content 字段', () => {
  const result = convert(
    {
      contents: [
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_weather', response: { content: '26C' } } }],
        },
      ],
    },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.body.messages[0], { role: 'tool', tool_call_id: 'get_weather', content: '26C' });
});

test('gemini->chat：functionResponse 的载荷是空对象时序列化成 {}', () => {
  const result = convert(
    { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: {} } }] }] },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '{}');
});

test('gemini->chat：不认识的 part 按键名记名丢弃', () => {
  const result = convert(
    { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA' } }] }] },
    'gemini',
    'chat',
  );
  assert.ok(result.dropped.includes('part:inlineData'), `实际：${result.dropped}`);
});

test('gemini->chat：tools 里没有 functionDeclarations 的条目被跳过', () => {
  const result = convert(
    {
      contents: [],
      tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'f' }] }],
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.tools.length, 1);
  assert.equal(result.body.tools[0].function.name, 'f');
});

test('gemini->chat：part 是空对象时按 unknown 记名', () => {
  const result = convert(
    { contents: [{ role: 'user', parts: [{}] }] },
    'gemini',
    'chat',
  );
  assert.ok(result.dropped.includes('part:unknown'), `实际：${result.dropped}`);
});

test('gemini->chat：functionResponse 整个缺失时给 JSON 空串', () => {
  const result = convert(
    { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f' } }] }] },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].content, '""');
});

// ---------------------------------------------------------------- 类型不对时不炸

test('chat->messages：content 既不是字符串也不是数组时给空内容', () => {
  const result = convert({ model: 'm', messages: [{ role: 'user', content: 42 }] }, 'chat', 'messages');
  assert.equal(result.body.messages[0].content, '');
});

test('chat->messages：messages 不是数组时不当消息处理', () => {
  const result = convert({ model: 'm', messages: 'oops' }, 'chat', 'messages');
  assert.deepEqual(result.body.messages, []);
});

test('chat->messages：扁平形状的工具（没有 function 层）也认', () => {
  const result = convert({ model: 'm', messages: [], tools: [{ name: 'f' }] }, 'chat', 'messages');
  assert.deepEqual(result.body.tools, [{ name: 'f', description: undefined, input_schema: { type: 'object' } }]);
});

test('chat->responses：扁平形状的工具也认，没有 parameters 时补空 schema', () => {
  const result = convert({ model: 'm', messages: [], tools: [{ name: 'f' }] }, 'chat', 'responses');
  assert.deepEqual(result.body.tools, [
    { type: 'function', name: 'f', description: undefined, parameters: { type: 'object' } },
  ]);
});

test('chat->responses：image_url 没有 url 时给空串', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] },
    'chat',
    'responses',
  );
  assert.deepEqual(result.body.input[0].content, [{ type: 'input_image', image_url: '' }]);
});

test('responses->chat：message 只有图片没有文本时 content 就是图片数组', () => {
  const result = convert(
    {
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x/a.png' }] }],
    },
    'responses',
    'chat',
  );
  assert.deepEqual(result.body.messages[0].content, [{ type: 'image_url', image_url: { url: 'https://x/a.png' } }]);
});

test('responses->chat：input 不是数组时不当条目处理', () => {
  const result = convert({ model: 'm', input: 'oops' }, 'responses', 'chat');
  assert.deepEqual(result.body.messages, []);
});

test('chat->gemini：assistant 同时有文本和工具调用时两种 part 都要', () => {
  const result = convert(
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: '先查一下',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
        },
      ],
    },
    'chat',
    'gemini',
  );
  assert.deepEqual(result.body.contents[0], {
    role: 'model',
    parts: [{ text: '先查一下' }, { functionCall: { name: 'f', args: { a: 1 } } }],
  });
});

test('chat->gemini：不认识的 content 部件记名丢弃', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'video', url: 'x' }] }] },
    'chat',
    'gemini',
  );
  assert.ok(result.dropped.includes('part:video'), `实际：${result.dropped}`);
});

test('chat->gemini：没有 type 的 content 部件按 unknown 记名', () => {
  const result = convert(
    { model: 'm', messages: [{ role: 'user', content: [{ url: 'x' }] }] },
    'chat',
    'gemini',
  );
  assert.ok(result.dropped.includes('part:unknown'));
});

test('chat->gemini：messages 不是数组时不当消息处理', () => {
  const result = convert({ model: 'm', messages: 'oops' }, 'chat', 'gemini');
  assert.deepEqual(result.body.contents, []);
});

test('messages->chat：messages 不是数组时不当消息处理', () => {
  const result = convert({ model: 'm', messages: 42 }, 'messages', 'chat');
  assert.deepEqual(result.body.messages, []);
});

test('gemini->chat：contents 不是数组时不当内容处理', () => {
  const result = convert({ contents: 'oops' }, 'gemini', 'chat');
  assert.deepEqual(result.body.messages, []);
});
