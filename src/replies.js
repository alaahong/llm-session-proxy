/**
 * 响应体互转（JSON，非流式）。方向是「上游协议 → 客户端协议」，
 * 与请求侧（converters.js）正好相反，覆盖同一批字段映射。
 *
 * messages→chat：content 块回填成 content/tool_calls，stop_reason 映射成 finish_reason，
 * usage 的 input/output_tokens 映射成 prompt/completion_tokens。
 * responses→chat：output 数组里的 message / function_call 拼回一条 assistant 消息。
 * messages↔responses 没有直达对，经 chat 中转。
 *
 * 4xx/5xx 错误体**不转换**——那是上游的原始错误，原样回传才好排查（proxy.js 的既有约定）。
 */

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** Anthropic stop_reason → OpenAI finish_reason。 */
const STOP_TO_FINISH = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const FINISH_TO_STOP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

// ---------------------------------------------------------------- messages → chat

function messagesJsonToChat(payload) {
  const dropped = [];
  const message = { role: 'assistant' };
  const text = [];
  const toolCalls = [];
  for (const block of asArray(payload.content)) {
    switch (block?.type) {
      case 'text':
        text.push(block.text || '');
        break;
      case 'tool_use':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      case 'thinking':
        dropped.push('thinking:block');
        break;
      default:
        dropped.push(`block:${block?.type || 'unknown'}`);
    }
  }
  if (text.length) message.content = text.join('');
  else if (toolCalls.length) message.content = null;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = payload.usage || {};
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;

  const out = {
    id: payload.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: STOP_TO_FINISH[payload.stop_reason] || 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
  if (usage.cache_read_input_tokens != null) out.usage.cache_read_input_tokens = usage.cache_read_input_tokens;
  return { payload: out, dropped };
}

// ---------------------------------------------------------------- chat → messages

function chatJsonToMessages(payload) {
  const dropped = [];
  const choice = asArray(payload.choices)[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === 'text') content.push({ type: 'text', text: part.text || '' });
      else dropped.push(`part:${part?.type || 'unknown'}`);
    }
  }
  for (const call of asArray(msg.tool_calls)) {
    let input = {};
    if (typeof call.function?.arguments === 'string') {
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        input = {};
        dropped.push('tool_calls:arguments_not_json');
      }
    } else if (call.function?.arguments && typeof call.function.arguments === 'object') {
      input = call.function.arguments;
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
  }

  const usage = payload.usage || {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  const out = {
    id: payload.id,
    type: 'message',
    role: 'assistant',
    model: payload.model,
    content,
    stop_reason: FINISH_TO_STOP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
  if (content.length === 0) out.content = [{ type: 'text', text: '' }];
  return { payload: out, dropped };
}

// ---------------------------------------------------------------- responses → chat

function responsesJsonToChat(payload) {
  const dropped = [];
  const text = [];
  const toolCalls = [];
  for (const item of asArray(payload.output)) {
    switch (item?.type) {
      case 'message':
        for (const part of asArray(item.content)) {
          if (part?.type === 'output_text') text.push(part.text || '');
          else dropped.push(`part:${part?.type || 'unknown'}`);
        }
        break;
      case 'function_call':
        toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } });
        break;
      case 'reasoning':
        dropped.push('reasoning:item');
        break;
      default:
        dropped.push(`item:${item?.type || 'unknown'}`);
    }
  }
  const message = { role: 'assistant' };
  if (text.length) message.content = text.join('');
  else if (toolCalls.length) message.content = null;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const incomplete = payload.status === 'incomplete' && payload.incomplete_details?.reason === 'max_output_tokens';
  const usage = payload.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;

  return {
    payload: {
      id: payload.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [{ index: 0, message, finish_reason: incomplete ? 'length' : toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    },
    dropped,
  };
}

// ---------------------------------------------------------------- chat → responses

function chatJsonToResponses(payload) {
  const dropped = [];
  const choice = asArray(payload.choices)[0] || {};
  const msg = choice.message || {};
  const output = [];
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  for (const call of asArray(msg.tool_calls)) {
    output.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || '{}' });
  }
  if (!output.length) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] });
  }

  const usage = payload.usage || {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  return {
    payload: {
      id: payload.id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: payload.model,
      output,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    },
    dropped,
  };
}

// ---------------------------------------------------------------- 注册表

const DIRECT = {
  'messages->chat': messagesJsonToChat,
  'chat->messages': chatJsonToMessages,
  'responses->chat': responsesJsonToChat,
  'chat->responses': chatJsonToResponses,
};

const VIA_CHAT = {
  'messages->responses': ['messages->chat', 'chat->responses'],
  'responses->messages': ['responses->chat', 'chat->messages'],
};

export function listResponseConverters() {
  return [...Object.keys(DIRECT), ...Object.keys(VIA_CHAT)];
}

/**
 * 转换一个非流式响应体。
 * @returns {{payload:object, changed:boolean, dropped:string[], via:string|null}}
 */
export function convertResponseJson(payload, from, to) {
  if (from === to || !payload || typeof payload !== 'object') {
    return { payload, changed: false, dropped: [], via: null };
  }
  const direct = DIRECT[`${from}->${to}`];
  if (direct) {
    const result = direct(payload) || {};
    return { payload: result.payload ?? payload, changed: true, dropped: result.dropped || [], via: null };
  }
  const path = VIA_CHAT[`${from}->${to}`];
  if (path) {
    const first = DIRECT[path[0]](payload) || {};
    const second = DIRECT[path[1]](first.payload) || {};
    return {
      payload: second.payload ?? first.payload,
      changed: true,
      dropped: [...(first.dropped || []), ...(second.dropped || [])],
      via: 'chat',
    };
  }
  return { payload, changed: false, dropped: [], via: null };
}
