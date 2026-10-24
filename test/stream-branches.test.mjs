import assert from 'node:assert/strict';
import test from 'node:test';

import { createSseParser, createStreamTranscoder } from '../src/stream.js';

/**
 * 流式转码的分支覆盖。
 *
 * stream.test.mjs 覆盖的是「主流路径的形状对不对」，这里补的是**边缘分支**：
 * 上游发来的畸形事件、没被认领的块类型、工具参数收不齐、
 * 以及各种协议组合下收尾事件的差异。
 *
 * 判据统一：要么形状对，要么把丢掉的东西**记名**报出来（stats.dropped）。
 */

// ---------------------------------------------------------------- 辅助

/** 把 [[event, data]] 序列拼成 SSE 文本。 */
function sseText(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 只取 data 帧（不带 event: 行的那些）。 */
function dataFrames(out) {
  return out
    .filter((text) => text.startsWith('data: ') && text !== 'data: [DONE]\n\n')
    .map((text) => JSON.parse(text.replace(/^data: /, '').replace(/\n\n$/, '')));
}

/** 取带 event: 行的帧，解析出 [eventName, payload]。 */
function eventFrames(out) {
  const frames = [];
  for (const text of out) {
    if (!text.startsWith('event: ')) continue;
    const [head, ...rest] = text.split('\n');
    const payload = JSON.parse(rest.join('\n').replace(/^data: /, '').replace(/\n\n$/, ''));
    frames.push([head.replace(/^event: /, ''), payload]);
  }
  return frames;
}

/** 跑一条流，返回写出文本与 stats。 */
function run({ from, to, events }) {
  const out = [];
  const transcoder = createStreamTranscoder({ from, to, write: (text) => out.push(text) });
  transcoder.push(sseText(events));
  transcoder.end();
  return { out, stats: transcoder.stats };
}

// ---------------------------------------------------------------- 解析器边界

test('SSE 解析器：没有 data 行的块被忽略', () => {
  const blocks = [];
  const parser = createSseParser((event, data) => blocks.push([event, data]));
  parser.feed('event: ping\n\n');
  parser.feed(': only a comment\n\n');
  assert.deepEqual(blocks, []);
});

test('SSE 解析器：空行开头的块也安全', () => {
  const blocks = [];
  const parser = createSseParser((event, data) => blocks.push([event, data]));
  parser.feed('\n\ndata: {"a":1}\n\n');
  assert.deepEqual(blocks, [['message', '{"a":1}']]);
});

// ---------------------------------------------------------------- 上游：chat

test('chat 上游：不是 JSON 的 data 被忽略', () => {
  const { out, stats } = run({ from: 'chat', to: 'responses', events: [['message', 'not json']] });
  assert.equal(stats.events, 1);
  // 坏数据不能变成内容增量
  assert.equal(out.some((text) => text.includes('output_text.delta')), false);
});

test('chat 上游：usage 塞在 choice 里也认', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', usage: { prompt_tokens: 3, completion_tokens: 4 } }] }],
    ],
  });
  const completed = eventFrames(out).find(([name]) => name === 'response.completed');
  assert.deepEqual(completed[1].response.usage, { input_tokens: 3, output_tokens: 4 });
});

test('chat 上游：顶层 usage（stream_options.include_usage）也认', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'hi' } }] }],
      // OpenAI 的 include_usage 收尾块：choices 是空数组，usage 在顶层
      ['message', { id: 'c1', model: 'gpt-x', choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }],
    ],
  });
  const completed = eventFrames(out).find(([name]) => name === 'response.completed');
  assert.deepEqual(completed[1].response.usage, { input_tokens: 5, output_tokens: 6 });
});

test('chat 上游：空 delta 的块不产生内容增量', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: {} }] }]],
  });
  // 只有开头与收尾两个事件，没有内容
  assert.equal(out.some((text) => text.includes('output_text.delta')), false);
  assert.equal(eventFrames(out).length, 2);
});

// ---------------------------------------------------------------- 上游：messages

test('messages 上游：不是 JSON 的 data 被忽略', () => {
  const { stats } = run({ from: 'messages', to: 'chat', events: [['message_start', 'not json']] });
  assert.equal(stats.events, 1);
});

test('messages 上游：signature_delta 也被丢弃并记名', () => {
  const { stats } = run({
    from: 'messages',
    to: 'chat',
    events: [
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
    ],
  });
  assert.ok(stats.dropped.includes('signature_delta'));
});

test('messages 上游：没被认领的 delta 类型记名丢弃', () => {
  const { stats } = run({
    from: 'messages',
    to: 'chat',
    events: [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta' } }]],
  });
  assert.ok(stats.dropped.includes('delta:citations_delta'));
});

test('messages 上游：delta 类型缺失时记为 unknown', () => {
  const { stats } = run({
    from: 'messages',
    to: 'chat',
    events: [['content_block_delta', { type: 'content_block_delta', index: 0, delta: {} }]],
  });
  assert.ok(stats.dropped.includes('delta:unknown'));
});

test('messages 上游：input_json_delta 对不上的 index 不炸', () => {
  const { stats } = run({
    from: 'messages',
    to: 'chat',
    events: [['content_block_delta', { type: 'content_block_delta', index: 99, delta: { type: 'input_json_delta', partial_json: '{' } }]],
  });
  assert.equal(stats.events, 1);
});

test('messages 上游：content_block_stop 对不上的 index 不产生工具调用', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['content_block_stop', { type: 'content_block_stop', index: 42 }]],
  });
  // 收尾块之外没有任何内容——没有工具调用混进来
  const chunks = dataFrames(out);
  const toolCalls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(toolCalls.length, 0);
});

test('messages 上游：没被认领的事件类型被忽略', () => {
  const { stats } = run({
    from: 'messages',
    to: 'chat',
    events: [['some_future_event', { type: 'some_future_event' }]],
  });
  assert.equal(stats.events, 1);
});

test('messages 上游：message_delta 缺 stop_reason 时不写停止原因', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['message_delta', { type: 'message_delta', delta: {} }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
});

test('messages 上游：content_block_start 不是 tool_use 时不登记工具', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }]],
  });
  const chunks = dataFrames(out);
  const toolCalls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(toolCalls.length, 0);
});

test('messages 上游：stop_reason 映射成 length', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [
      ['message_start', { type: 'message_start', message: { id: 'm', model: 'x' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }],
    ],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'length');
});

test('messages 上游：stop_reason 映射成 content_filter', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' } }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'content_filter');
});

test('messages 上游：认不出的 stop_reason 兜底成 stop', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['message_delta', { type: 'message_delta', delta: { stop_reason: 'weird' } }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
});

// ---------------------------------------------------------------- 上游：gemini

test('gemini 上游：认不出的 part 记名丢弃', () => {
  const { stats } = run({
    from: 'gemini',
    to: 'chat',
    events: [['message', { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'A' } }] } }] }]],
  });
  assert.ok(stats.dropped.includes('part:inlineData'));
});

test('gemini 上游：空文本 part 不产生内容增量', () => {
  const { out } = run({
    from: 'gemini',
    to: 'chat',
    events: [['message', { candidates: [{ content: { parts: [{ text: '' }] } }] }]],
  });
  const chunks = dataFrames(out);
  const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter((t) => typeof t === 'string').join('');
  assert.equal(text, '');
});

test('gemini 上游：finishReason 映射成 content_filter', () => {
  const { out } = run({
    from: 'gemini',
    to: 'chat',
    events: [['message', { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'content_filter');
});

test('gemini 上游：认不出的 finishReason 兜底成 stop', () => {
  const { out } = run({
    from: 'gemini',
    to: 'chat',
    events: [['message', { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'WEIRD' }] }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
});

test('gemini 上游：usageMetadata 的 token 数进 usage', () => {
  const { out } = run({
    from: 'gemini',
    to: 'chat',
    events: [
      ['message', { modelVersion: 'gemini-2.5-pro', responseId: 'r1', candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 9, totalTokenCount: 17 } }],
    ],
  });
  const chunks = dataFrames(out);
  const tail = chunks[chunks.length - 1];
  // 流式里的 usage 只有两键（total 是非流式才有的）
  assert.deepEqual(tail.usage, { prompt_tokens: 8, completion_tokens: 9 });
});

test('gemini 上游：不是 JSON 的 data 不炸', () => {
  const { stats } = run({ from: 'gemini', to: 'chat', events: [['message', 'not json']] });
  assert.equal(stats.events, 1);
});

test('gemini 上游：candidates 是单个对象而不是数组时也认', () => {
  const { out } = run({
    from: 'gemini',
    to: 'chat',
    events: [['message', { candidates: { content: { parts: [{ text: 'hi' }] } } }]],
  });
  const chunks = dataFrames(out);
  const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter((t) => typeof t === 'string').join('');
  assert.equal(text, 'hi');
});

// ---------------------------------------------------------------- 上游：responses

test('responses 上游：output_text.delta 变成内容增量', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [
      ['response.created', { type: 'response.created', response: { id: 'r1', model: 'gpt-x' } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello' }],
    ],
  });
  const chunks = dataFrames(out);
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content).filter((t) => typeof t === 'string').join('');
  assert.equal(text, 'hello');
});

test('responses 上游：response.in_progress 也会取到 id 与 model', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [['response.in_progress', { type: 'response.in_progress', response: { id: 'r2', model: 'gpt-y' } }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[0].id, 'r2');
  assert.equal(chunks[0].model, 'gpt-y');
});

test('responses 上游：output_item.added 登记 function_call', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [
      ['response.output_item.added', { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c1', name: 'f' } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', call_id: 'c1', delta: '{"a":1}' }],
      ['response.output_item.done', { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' } }],
    ],
  });
  const chunks = dataFrames(out);
  const call = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])[0];
  assert.equal(call.function.arguments, '{"a":1}');
});

test('responses 上游：output_item.added 不是 function_call 时不登记', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [['response.output_item.added', { type: 'response.output_item.added', item: { type: 'message' } }]],
  });
  const chunks = dataFrames(out);
  const toolCalls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(toolCalls.length, 0);
});

test('responses 上游：function_call_arguments.delta 对不上的 call_id 不炸', () => {
  const { stats } = run({
    from: 'responses',
    to: 'chat',
    events: [['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', call_id: 'nope', delta: '{' }]],
  });
  assert.equal(stats.events, 1);
});

test('responses 上游：output_item.done 不是 function_call 时不产工具调用', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [['response.output_item.done', { type: 'response.output_item.done', item: { type: 'message' } }]],
  });
  const chunks = dataFrames(out);
  const toolCalls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(toolCalls.length, 0);
});

test('responses 上游：response.completed 带 usage 并把停止原因定为 stop', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [
      ['response.created', { type: 'response.created', response: { id: 'r1', model: 'gpt-x' } }],
      ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3 } } }],
    ],
  });
  const chunks = dataFrames(out);
  const tail = chunks[chunks.length - 1];
  assert.equal(tail.choices[0].finish_reason, 'stop');
  assert.deepEqual(tail.usage, { prompt_tokens: 2, completion_tokens: 3 });
});

test('responses 上游：response.incomplete 把停止原因定为 length', () => {
  const { out } = run({
    from: 'responses',
    to: 'chat',
    events: [['response.incomplete', { type: 'response.incomplete', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'length');
});

test('responses 上游：没被认领的事件类型被忽略', () => {
  const { stats } = run({
    from: 'responses',
    to: 'chat',
    events: [['response.some_future', { type: 'response.some_future' }]],
  });
  assert.equal(stats.events, 1);
});

// ---------------------------------------------------------------- 下行：工具调用

test('下行到 messages：工具调用发 content_block_start 与 input_json_delta', () => {
  const { out } = run({
    from: 'chat',
    to: 'messages',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }],
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }] }],
    ],
  });
  const frames = eventFrames(out);
  const names = frames.map(([name]) => name);
  assert.ok(names.includes('message_start'));
  assert.ok(names.includes('content_block_start'));
  assert.ok(names.includes('content_block_delta'));
  assert.ok(names.includes('content_block_stop'));
  const delta = frames.find(([name, payload]) => name === 'content_block_delta' && payload.delta?.type === 'input_json_delta');
  assert.equal(delta[1].delta.partial_json, '{"a":1}');
});

test('下行到 responses：工具调用发 output_item.added 与 arguments.delta', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }],
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }] }],
    ],
  });
  const frames = eventFrames(out);
  const names = frames.map(([name]) => name);
  assert.ok(names.includes('response.created'));
  assert.ok(names.includes('response.output_item.added'));
  assert.ok(names.includes('response.function_call_arguments.delta'));
  assert.ok(names.includes('response.completed'));
});

test('下行到 gemini：工具参数能解析成 JSON 时整块发 functionCall', () => {
  const { out } = run({
    from: 'chat',
    to: 'gemini',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }],
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }] }],
    ],
  });
  const frames = dataFrames(out);
  const withCall = frames.find((frame) => frame.candidates?.[0]?.content?.parts?.[0]?.functionCall);
  assert.deepEqual(withCall.candidates[0].content.parts[0].functionCall, { name: 'f', args: { a: 1 } });
});

test('下行到 gemini：工具参数分片收不齐时等收尾才补发', () => {
  const { out } = run({
    from: 'chat',
    to: 'gemini',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }],
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":' } }] } }] }],
    ],
  });
  const frames = dataFrames(out);
  const withCall = frames.find((frame) => frame.candidates?.[0]?.content?.parts?.[0]?.functionCall);
  // 收不齐就没有可解析的参数，只能给空对象
  assert.deepEqual(withCall.candidates[0].content.parts[0].functionCall, { name: 'f', args: {} });
});

test('下行到 responses：收尾时把工具调用拼进 output', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }],
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }] }],
    ],
  });
  const completed = eventFrames(out).find(([name]) => name === 'response.completed');
  const output = completed[1].response.output;
  assert.equal(output[0].type, 'function_call');
  assert.equal(output[0].arguments, '{"a":1}');
});

test('下行到 responses：没有文本时 output 为空数组', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }]],
  });
  const completed = eventFrames(out).find(([name]) => name === 'response.completed');
  assert.deepEqual(completed[1].response.output, []);
});

test('下行到 responses：finish_reason 是 length 时状态为 incomplete', () => {
  const { out } = run({
    from: 'chat',
    to: 'responses',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] }]],
  });
  const completed = eventFrames(out).find(([name]) => name === 'response.completed');
  assert.equal(completed[1].response.status, 'incomplete');
});

// ---------------------------------------------------------------- 下行：文本与收尾

test('下行到 messages：文本增量开一个 content_block 并在收尾关掉', () => {
  const { out } = run({
    from: 'chat',
    to: 'messages',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'hi' } }] }]],
  });
  const frames = eventFrames(out);
  const names = frames.map(([name]) => name);
  assert.ok(names.includes('content_block_start'));
  assert.ok(names.includes('content_block_stop'));
  assert.ok(names.includes('message_delta'));
  assert.ok(names.includes('message_stop'));
});

test('下行到 messages：message_delta 带 output_tokens', () => {
  const { out } = run({
    from: 'chat',
    to: 'messages',
    events: [
      ['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', usage: { prompt_tokens: 4, completion_tokens: 6 } }] }],
    ],
  });
  const delta = eventFrames(out).find(([name]) => name === 'message_delta');
  assert.deepEqual(delta[1].usage, { output_tokens: 6 });
  assert.equal(delta[1].delta.stop_reason, 'end_turn');
});

test('下行到 messages：finish_reason=tool_calls 映射成 tool_use', () => {
  const { out } = run({
    from: 'chat',
    to: 'messages',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }] }]],
  });
  const delta = eventFrames(out).find(([name]) => name === 'message_delta');
  assert.equal(delta[1].delta.stop_reason, 'tool_use');
});

test('下行到 messages：认不出的 finish_reason 兜底成 end_turn', () => {
  const { out } = run({
    from: 'chat',
    to: 'messages',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'weird' }] }]],
  });
  const delta = eventFrames(out).find(([name]) => name === 'message_delta');
  assert.equal(delta[1].delta.stop_reason, 'end_turn');
});

test('下行到 gemini：收尾发最后一个候选块，带 finishReason 与 usage', () => {
  const { out } = run({
    from: 'chat',
    to: 'gemini',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', usage: { prompt_tokens: 2, completion_tokens: 3 } }] }]],
  });
  const frames = dataFrames(out);
  const tail = frames[frames.length - 1];
  assert.equal(tail.candidates[0].finishReason, 'STOP');
  assert.deepEqual(tail.usageMetadata, { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 });
});

test('下行到 gemini：finish_reason=content_filter 映射成 SAFETY', () => {
  const { out } = run({
    from: 'chat',
    to: 'gemini',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'content_filter' }] }]],
  });
  const frames = dataFrames(out);
  assert.equal(frames[frames.length - 1].candidates[0].finishReason, 'SAFETY');
});

test('下行到 gemini：finish_reason=length 映射成 MAX_TOKENS', () => {
  const { out } = run({
    from: 'chat',
    to: 'gemini',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'length' }] }]],
  });
  const frames = dataFrames(out);
  assert.equal(frames[frames.length - 1].candidates[0].finishReason, 'MAX_TOKENS');
});

test('下行到 chat：收尾块没有 usage 时不带 usage 字段', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [
      ['message_start', { type: 'message_start', message: { id: 'm', model: 'x' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ],
  });
  const chunks = dataFrames(out);
  const tail = chunks[chunks.length - 1];
  assert.equal(tail.usage, undefined);
});

test('下行到 chat：上游带 usage 时收尾块带 usage', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [
      ['message_start', { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 1 } } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
    ],
  });
  const chunks = dataFrames(out);
  const tail = chunks[chunks.length - 1];
  assert.deepEqual(tail.usage, { prompt_tokens: 1, completion_tokens: 2 });
});

test('下行到 chat：首块带 role 时不再补一个开头块', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['message_start', { type: 'message_start', message: { id: 'm', model: 'x' } }]],
  });
  const chunks = dataFrames(out);
  // 一个 role 块 + 一个收尾块，没有多余的空开头块
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
});

test('下行到 messages：首块带 role 与文本时不能丢掉首段文本', () => {
  const { out } = run({
    from: 'chat',
    to: 'messages',
    events: [['message', { id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }] }]],
  });
  const frames = eventFrames(out);
  const textDelta = frames.find(([name, payload]) => name === 'content_block_delta' && payload.delta?.type === 'text_delta');
  assert.equal(textDelta[1].delta.text, 'hi');
});

test('from === to 直接报错', () => {
  assert.throws(() => createStreamTranscoder({ from: 'chat', to: 'chat', write: () => {} }), /from === to/);
});

// ---------------------------------------------------------------- 边界

test('上游没给 id 与 model 时不炸', () => {
  const { out } = run({
    from: 'messages',
    to: 'chat',
    events: [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }]],
  });
  const chunks = dataFrames(out);
  assert.equal(chunks[0].id, null);
  assert.equal(chunks[0].model, null);
});

test('push 收到 Buffer 时按 utf8 解码', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  transcoder.push(Buffer.from(sseText([['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }]]), 'utf8'));
  transcoder.end();
  const chunks = dataFrames(out);
  // 第一块是 role 开头块，文本在第二块
  const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content).filter((t) => typeof t === 'string').join('');
  assert.equal(text, 'hi');
});

test('end() 之后再来字节不产生第二段流', () => {
  const out = [];
  const transcoder = createStreamTranscoder({ from: 'messages', to: 'chat', write: (text) => out.push(text) });
  transcoder.push(sseText([['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }]]));
  transcoder.end();
  const before = out.length;
  transcoder.push(sseText([['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'more' } }]]));
  assert.equal(out.length, before);
});
