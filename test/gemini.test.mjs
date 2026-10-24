import test from 'node:test';
import assert from 'node:assert/strict';

import { convertRequestBody, listConverters } from '../src/converters.js';
import { convertResponseJson } from '../src/replies.js';
import { createStreamTranscoder } from '../src/stream.js';

// ---------------------------------------------------------------- 请求侧

test('chat → gemini：messages 变成 contents，role 归一为 user / model', () => {
  const result = convertRequestBody(
    {
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'again' },
      ],
    },
    'chat',
    'gemini',
  );
  assert.equal(result.changed, true);
  assert.equal(result.body.systemInstruction.parts[0].text, 'be terse');
  assert.deepEqual(result.body.contents, [
    { role: 'user', parts: [{ text: 'hello' }] },
    { role: 'model', parts: [{ text: 'hi' }] },
    { role: 'user', parts: [{ text: 'again' }] },
  ]);
  assert.ok(result.body.model === undefined, 'model 不该留在 body 里（它在上游路径上）');
});

test('chat → gemini：参数进 generationConfig', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: 1234,
      stop: ['END'],
      reasoning_effort: 'high',
    },
    'chat',
    'gemini',
  );
  assert.equal(result.body.generationConfig.temperature, 0.3);
  assert.equal(result.body.generationConfig.topP, 0.8);
  assert.equal(result.body.generationConfig.maxOutputTokens, 1234);
  assert.deepEqual(result.body.generationConfig.stopSequences, ['END']);
  assert.equal(result.body.generationConfig.thinkingConfig.thinkingBudget, 16384);
});

test('chat → gemini：工具变成 functionDeclarations', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'weather', parameters: { type: 'object' } },
        },
      ],
    },
    'chat',
    'gemini',
  );
  assert.equal(result.body.tools.length, 1);
  assert.equal(result.body.tools[0].functionDeclarations.length, 1);
  assert.equal(result.body.tools[0].functionDeclarations[0].name, 'get_weather');
  assert.equal(result.body.tools[0].functionDeclarations[0].description, 'weather');
});

test('chat → gemini：tool_calls 变成 model 内容里的 functionCall', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
        },
      ],
    },
    'chat',
    'gemini',
  );
  assert.equal(result.body.contents[0].role, 'model');
  assert.deepEqual(result.body.contents[0].parts[0], { functionCall: { name: 'f', args: { a: 1 } } });
});

test('gemini → chat：contents 变回 messages', () => {
  const result = convertRequestBody(
    {
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ],
      systemInstruction: { parts: [{ text: 'be terse' }] },
      generationConfig: { maxOutputTokens: 999, temperature: 0.5 },
    },
    'gemini',
    'chat',
  );
  assert.deepEqual(result.body.messages, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal(result.body.max_tokens, 999);
  assert.equal(result.body.temperature, 0.5);
});

test('gemini → chat：functionCall 变回 tool_calls', () => {
  const result = convertRequestBody(
    {
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
      ],
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].role, 'assistant');
  assert.equal(result.body.messages[0].tool_calls[0].function.name, 'f');
  assert.equal(result.body.messages[0].tool_calls[0].function.arguments, '{"a":1}');
});

test('gemini → chat：functionResponse 变回独立的 tool 消息', () => {
  const result = convertRequestBody(
    {
      contents: [
        { role: 'user', parts: [{ functionResponse: { name: 'f', response: { content: '42' } } }] },
      ],
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.messages[0].role, 'tool');
  assert.equal(result.body.messages[0].tool_call_id, 'f');
  assert.equal(result.body.messages[0].content, '42');
});

test('gemini → chat：thinkingBudget 变回 reasoning_effort', () => {
  const result = convertRequestBody(
    {
      contents: [{ role: 'user', parts: [{ text: 'x' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 16384 } },
    },
    'gemini',
    'chat',
  );
  assert.equal(result.body.reasoning_effort, 'high');
});

test('messages ↔ gemini 没有直达对，经 chat 中转', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    },
    'messages',
    'gemini',
  );
  assert.equal(result.via, 'chat');
  assert.equal(result.body.contents[0].parts[0].text, 'hello');
  assert.equal(result.body.generationConfig.maxOutputTokens, 100);
});

test('responses → gemini 经 chat 中转', () => {
  const result = convertRequestBody(
    {
      model: 'm',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hey' }] }],
    },
    'responses',
    'gemini',
  );
  assert.equal(result.via, 'chat');
  assert.equal(result.body.contents[0].parts[0].text, 'hey');
});

test('同协议不转换', () => {
  const body = { contents: [] };
  const result = convertRequestBody(body, 'gemini', 'gemini');
  assert.equal(result.changed, false);
  assert.equal(result.body, body);
});

// ---------------------------------------------------------------- 响应侧

test('gemini → chat：candidates 变回 choices，usageMetadata 变回 usage', () => {
  const result = convertResponseJson(
    {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      modelVersion: 'gemini-3.5-flash',
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 },
    },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.choices[0].message.content, 'hello');
  assert.equal(result.payload.choices[0].finish_reason, 'stop');
  assert.equal(result.payload.usage.prompt_tokens, 11);
  assert.equal(result.payload.usage.completion_tokens, 22);
  assert.equal(result.payload.usage.total_tokens, 33);
  assert.equal(result.payload.model, 'gemini-3.5-flash');
});

test('gemini → chat：MAX_TOKENS 映射成 length', () => {
  const result = convertResponseJson(
    { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.choices[0].finish_reason, 'length');
});

test('gemini → chat：functionCall 变回 tool_calls', () => {
  const result = convertResponseJson(
    { candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] } }] },
    'gemini',
    'chat',
  );
  assert.equal(result.payload.choices[0].message.tool_calls[0].function.name, 'f');
  assert.equal(result.payload.choices[0].finish_reason, 'tool_calls');
});

test('chat → gemini：choices 变回 candidates', () => {
  const result = convertResponseJson(
    {
      id: 'r1',
      model: 'gemini-3.5-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    },
    'chat',
    'gemini',
  );
  assert.equal(result.payload.candidates[0].content.parts[0].text, 'hello');
  assert.equal(result.payload.candidates[0].finishReason, 'STOP');
  assert.equal(result.payload.usageMetadata.promptTokenCount, 5);
  assert.equal(result.payload.usageMetadata.candidatesTokenCount, 7);
  assert.equal(result.payload.usageMetadata.totalTokenCount, 12);
});

// ---------------------------------------------------------------- 流式

function collect(parts) {
  const out = [];
  const transcoder = createStreamTranscoder({ from: parts.from, to: parts.to, write: (text) => out.push(text) });
  for (const chunk of parts.chunks) transcoder.push(chunk);
  transcoder.end();
  return out.join('');
}

test('gemini 上游 → chat 客户端：文本增量转成 chat chunk', () => {
  const output = collect({
    from: 'gemini',
    to: 'chat',
    chunks: [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}],"role":"model"}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n',
    ],
  });
  assert.ok(output.includes('"content":"Hel"'));
  assert.ok(output.includes('"content":"lo"'));
  assert.ok(output.includes('"finish_reason":"stop"'));
  assert.ok(output.includes('"prompt_tokens":3'));
  assert.ok(output.includes('"completion_tokens":4'));
  assert.ok(output.includes('[DONE]'));
});

test('chat 上游 → gemini 客户端：文本增量转成 candidates', () => {
  const output = collect({
    from: 'chat',
    to: 'gemini',
    chunks: [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
    ],
  });
  assert.ok(output.includes('"candidates"'));
  assert.ok(output.includes('"text":"Hel"'));
  assert.ok(output.includes('"text":"lo"'));
  assert.ok(output.includes('"finishReason":"STOP"'));
  assert.ok(output.includes('"promptTokenCount":2'));
});

test('gemini 工具调用在流里转成 chat 的 tool_calls', () => {
  const output = collect({
    from: 'gemini',
    to: 'chat',
    chunks: [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"a":1}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ],
  });
  assert.ok(output.includes('"tool_calls"'));
  assert.ok(output.includes('"name":"f"'));
  assert.ok(output.includes('"arguments":"{\\"a\\":1}"'));
});
