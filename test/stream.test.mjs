import assert from 'node:assert/strict';
import test from 'node:test';

import { createSseParser, createStreamTranscoder } from '../src/stream.js';

// ---------------------------------------------------------------- 解析器

test('SSE 解析器：任意切分都能按空行组装事件，注释与 [DONE] 各就各位', () => {
  const blocks = [];
  const parser = createSseParser((event, data) => blocks.push([event, data]));
  const stream = [
    'event: message_start\n',
    'data: {"a":1}\n',
    ': keep-alive comment\n\n',
    'data: {"b":',
    '2}\ndata: {"c":3}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const part of stream) parser.feed(part);

  assert.deepEqual(blocks, [
    ['message_start', '{"a":1}'],
    // 同一块里的多行 data 按 SSE 规范用换行拼接
    ['message', '{"b":2}\n{"c":3}'],
    ['done', null],
  ]);
});

test('SSE 解析器：容忍 \\r\\n 与多余的 data 合并', () => {
  const blocks = [];
  const parser = createSseParser((event, data) => blocks.push([event, data]));
  parser.feed('event: x\r\ndata: line1\r\ndata: line2\r\n\r\n');
  assert.deepEqual(blocks, [['x', 'line1\nline2']]);
});

// ---------------------------------------------------------------- messages -> chat（上游 Anthropic，客户端 OpenAI）

function messagesSse({ text = 'Hello', toolName = null, stopReason = 'end_turn', thinking = false } = {}) {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'glm-5.3', usage: { input_tokens: 12 } } }],
  ];
  if (thinking) {
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  }
  events.push(['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }]);
  for (const part of text.match(/.{1,3}/gs) || []) {
    events.push(['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: part } }]);
  }
  events.push(['content_block_stop', { type: 'content_block_stop', index: 1 }]);
  if (toolName) {
    events.push(['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_1', name: toolName, input: {} } }]);
    events.push(['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"sz"}' } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index: 2 }]);
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events;
}

function sseText(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

test('messages->chat：文本增量转 content 块，thinking 丢弃，收尾带 finish_reason 与 usage', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  transcoder.push(sseText(messagesSse({ thinking: true })));
  transcoder.end();

  const chunks = out
    .filter((text) => text !== 'data: [DONE]\n\n')
    .map((text) => JSON.parse(text.replace(/^data: /, '').replace(/\n\n$/, '')));
  assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.delta?.role === 'assistant'), '开头要有 role 增量');
  const textDelta = chunks
    .map((chunk) => chunk.choices?.[0]?.delta?.content)
    .filter((content) => typeof content === 'string')
    .join('');
  assert.equal(textDelta, 'Hello');
  // thinking_delta 被丢弃（chat 没有标准位），不能以 content 的形式漏出去
  assert.ok(!JSON.stringify(chunks).includes('hmm'));

  const tail = chunks[chunks.length - 1]; // [DONE] 已被过滤，收尾块就是最后一条
  assert.equal(tail.choices[0].finish_reason, 'stop');
  assert.deepEqual(tail.usage, { prompt_tokens: 12, completion_tokens: 7 });
  assert.equal(out[out.length - 1], 'data: [DONE]\n\n');
});

test('messages->chat：tool_use 块转成 tool_calls 增量，stop_reason=tool_use 映射正确', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  transcoder.push(sseText(messagesSse({ text: '', toolName: 'get_weather', stopReason: 'tool_use' })));

  const chunks = out
    .filter((text) => text !== 'data: [DONE]\n\n')
    .map((text) => JSON.parse(text.replace(/^data: /, '').replace(/\n\n$/, '')));
  const call = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])[0];
  assert.equal(call.id, 'call_1');
  assert.equal(call.function.name, 'get_weather');
  assert.equal(call.function.arguments, '{"city":"sz"}');
  const tail = chunks[chunks.length - 1];
  assert.equal(tail.choices[0].finish_reason, 'tool_calls');
});

test('messages->chat：字节任意切分不乱序（缓冲要能跨 chunk 组包）', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  const whole = sseText(messagesSse());
  for (let index = 0; index < whole.length; index += 7) transcoder.push(whole.slice(index, index + 7));
  transcoder.end();

  const textDelta = out
    .map((text) => {
      try {
        return JSON.parse(text.replace(/^data: /, '').replace(/\n\n$/, ''));
      } catch {
        return null;
      }
    })
    .map((chunk) => chunk?.choices?.[0]?.delta?.content)
    .filter((content) => typeof content === 'string')
    .join('');
  assert.equal(textDelta, 'Hello');
});

// ---------------------------------------------------------------- chat -> messages（上游 OpenAI，客户端 Anthropic）

test('chat->messages：重建 message_start / content_block_delta / message_stop 事件序列', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'chat', to: 'messages', write: (text) => out.push(text) });
  const chunks = [
    { id: 'cmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'cmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
    { id: 'cmpl-1', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 2 } }] },
  ];
  transcoder.push(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  transcoder.end();

  const events = out.map((text) => {
    const event = /^event: (.+)$/m.exec(text)[1];
    return [event, JSON.parse(/^data: (.+)$/m.exec(text)[1])];
  });
  assert.deepEqual(
    events.map(([event]) => event),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
  );
  assert.equal(events[0][1].message.model, 'glm-5.3');
  assert.equal(events[2][1].delta.text, 'Hi');
  assert.equal(events[4][1].delta.stop_reason, 'end_turn');
  assert.equal(events[4][1].usage.output_tokens, 2);
});

// ---------------------------------------------------------------- chat -> responses 与 responses -> chat

test('chat->responses：重建 response.created / output_text.delta / response.completed', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'chat', to: 'responses', write: (text) => out.push(text) });
  const chunks = [
    { id: 'cmpl-9', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: 'AB' }, finish_reason: null }] },
    { id: 'cmpl-9', object: 'chat.completion.chunk', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'length', usage: { prompt_tokens: 3, completion_tokens: 4 } }] },
  ];
  transcoder.push(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''));
  transcoder.end();

  const events = out.map((text) => {
    const event = /^event: (.+)$/m.exec(text)[1];
    return [event, JSON.parse(/^data: (.+)$/m.exec(text)[1])];
  });
  assert.equal(events[0][0], 'response.created');
  assert.equal(events[0][1].response.model, 'glm-5.3');
  const deltas = events.filter(([event]) => event === 'response.output_text.delta');
  assert.equal(deltas.map(([, data]) => data.delta).join(''), 'AB');
  const done = events[events.length - 1];
  assert.equal(done[0], 'response.completed');
  assert.equal(done[1].response.status, 'incomplete');
  assert.deepEqual(done[1].response.output, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'AB' }] },
  ]);
});

test('responses->chat：function_call 参数增量聚成完整 tool_calls 块', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'responses', to: 'chat', write: (text) => out.push(text) });
  const events = [
    ['response.created', { type: 'response.created', response: { id: 'r1', model: 'glm-5.3' } }],
    ['response.output_item.added', { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '' } }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', call_id: 'c1', delta: '{"a"' }],
    ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', call_id: 'c1', delta: ':1}' }],
    ['response.output_item.done', { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' } }],
    ['response.completed', { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 2 } } }],
  ];
  transcoder.push(sseText(events));

  const chunks = out
    .filter((text) => text !== 'data: [DONE]\n\n')
    .map((text) => JSON.parse(text.replace(/^data: /, '').replace(/\n\n$/, '')));
  const call = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])[0];
  assert.equal(call.function.arguments, '{"a":1}');
  const tail = chunks[chunks.length - 1];
  assert.equal(tail.choices[0].finish_reason, 'stop');
  assert.equal(out[out.length - 1], 'data: [DONE]\n\n');
});

// ---------------------------------------------------------------- 边界

test('end() 幂等，收尾事件只发一次', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  transcoder.push(sseText(messagesSse()));
  transcoder.end();
  transcoder.end();
  transcoder.end();
  assert.equal(out.filter((text) => text === 'data: [DONE]\n\n').length, 1);
});

test('上游结束后再来的字节被忽略，不会产生第二段流', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  transcoder.push(sseText(messagesSse()));
  transcoder.end();
  const before = out.length;
  transcoder.push(sseText(messagesSse()));
  assert.equal(out.length, before);
});
