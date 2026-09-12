/**
 * 请求体互转（v0.2.2）。四种直达方向：chat↔messages、chat↔responses；
 * messages↔responses 没有直达对，经 chat 中转（组合时各自报 changes）。
 *
 * 设计约束：
 * - 返回**新对象**，不改传入的 body——调用方要拿转换结果替换 parsedBody。
 * - changes 是短 ASCII 标签（`system:moved`、`max_tokens:default(4096)`），
 *   进日志时可 grep；dropped 记录「无等价字段、只好丢掉」的东西，让人知道丢了什么。
 * - 每个方向都保证产出目标协议的**必填字段**（如 messages 的 max_tokens），
 *   缺了就补一个保守默认值并明说，而不是让上游 400 再让用户猜。
 * - 归一化表都是写死的：reasoning_effort ↔ thinking 预算、工具调用形状、
 *   stop ↔ stop_sequences。这些是路线图里点名要做的字段归一化。
 */

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function safeJsonParse(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** chat 的 content 可能是字符串，也可能是分段数组；取出纯文本。 */
function textFromChatContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
    .map((part) => part.text)
    .filter((text) => typeof text === 'string')
    .join('');
}

/** data URL 拆成 Anthropic 的 base64 source；普通 URL 原样走 url source。 */
function chatImageToMessagesSource(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  if (match) return { type: 'base64', media_type: match[1], data: match[2] };
  return { type: 'url', url: String(url || '') };
}

function messagesSourceToChatUrl(source) {
  if (!source || typeof source !== 'object') return '';
  if (source.type === 'base64') return `data:${source.media_type || 'image/png'};base64,${source.data || ''}`;
  return source.url || '';
}

/** Anthropic 的 system 可以是字符串，也可以是分段数组。 */
function textFromMessagesSystem(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .filter(Boolean)
    .join('\n');
}

/** messages 的 content 块数组 → chat 的 content（字符串或分段数组）。 */
function messagesBlocksToChat(blocks) {
  const images = [];
  const text = [];
  const toolUses = [];
  const toolResults = [];
  const dropped = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    switch (block?.type) {
      case 'text':
        text.push(block.text || '');
        break;
      case 'image':
        images.push({ type: 'image_url', image_url: { url: messagesSourceToChatUrl(block.source) } });
        break;
      case 'tool_use':
        toolUses.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
        break;
      case 'tool_result':
        toolResults.push(block);
        break;
      case 'thinking':
        dropped.push('thinking:block');
        break;
      default:
        dropped.push(`block:${block?.type || 'unknown'}`);
    }
  }
  return { images, text: text.filter(Boolean).join(''), toolUses, toolResults, dropped };
}

function toolResultToText(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('');
  }
  return '';
}

/** reasoning_effort → thinking 预算。写死的中转表，两端都能反推。 */
const REASONING_TO_BUDGET = { low: 1024, medium: 8192, high: 16384 };

function budgetToReasoning(budget) {
  const value = Number(budget);
  if (!Number.isFinite(value)) return 'medium';
  if (value >= 16384) return 'high';
  if (value >= 4096) return 'medium';
  return 'low';
}

/** chat 与 messages 共用的可透传数值字段。 */
function copyCommonNumbers(from, to, keys = ['temperature', 'top_p']) {
  for (const key of keys) {
    if (typeof from[key] === 'number') to[key] = from[key];
  }
}

/** chat 里没有 messages 等价物的字段，逐个记名丢弃。 */
const CHAT_ONLY_FIELDS = [
  'response_format', 'stream_options', 'seed', 'logprobs', 'top_logprobs', 'n', 'user',
  'presence_penalty', 'frequency_penalty', 'logit_bias', 'service_tier', 'parallel_tool_calls',
  'store', 'safety_identifier',
];

// ---------------------------------------------------------------- chat → messages

function chatToMessages(body) {
  const changes = [];
  const dropped = [];
  const out = { model: body.model };
  copyCommonNumbers(body, out);

  // Anthropic 把 max_tokens 当必填：chat 两个名字都认，都没有就补保守默认值
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens != null) out.max_tokens = maxTokens;
  else {
    out.max_tokens = 4096;
    changes.push('max_tokens:default(4096)');
  }

  if (body.stop != null) {
    out.stop_sequences = asArray(body.stop);
    changes.push('stop->stop_sequences');
  }

  if (typeof body.reasoning_effort === 'string' && REASONING_TO_BUDGET[body.reasoning_effort]) {
    out.thinking = { type: 'enabled', budget_tokens: REASONING_TO_BUDGET[body.reasoning_effort] };
    changes.push(`reasoning_effort->thinking(${REASONING_TO_BUDGET[body.reasoning_effort]})`);
  } else if (body.reasoning_effort != null) {
    dropped.push(`reasoning_effort:${body.reasoning_effort}`);
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((tool) => {
      const fn = tool?.function || tool;
      return { name: fn?.name, description: fn?.description, input_schema: fn?.parameters || { type: 'object' } };
    });
    changes.push('tools:flattened');
  }

  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required' || choice === 'any') out.tool_choice = { type: 'any' };
  else if (choice === 'none') {
    delete out.tools;
    changes.push('tool_choice:none->tools_dropped');
  } else if (choice && typeof choice === 'object' && choice.function?.name) {
    out.tool_choice = { type: 'tool', name: choice.function.name };
  } else if (choice && typeof choice === 'object' && choice.type === 'tool') {
    out.tool_choice = choice;
  }

  const systemParts = [];
  const messages = [];
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;
    if (role === 'system' || role === 'developer') {
      systemParts.push(textFromChatContent(msg.content));
      continue;
    }
    if (role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: textFromChatContent(msg.content) }],
      });
      changes.push('tool:message->tool_result');
      continue;
    }
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const blocks = [];
      const text = textFromChatContent(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of msg.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input: safeJsonParse(call.function?.arguments) ?? {},
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      changes.push('tool_calls->tool_use');
      continue;
    }
    const content = msg?.content;
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    const blocks = [];
    let sawText = false;
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === 'text') {
        blocks.push({ type: 'text', text: part.text || '' });
        sawText = true;
      } else if (part?.type === 'image_url') {
        blocks.push({ type: 'image', source: chatImageToMessagesSource(part.image_url?.url) });
      } else if (part) {
        dropped.push(`part:${part.type || 'unknown'}`);
      }
    }
    messages.push({ role, content: sawText || blocks.length ? blocks : '' });
  }
  if (systemParts.length) {
    out.system = systemParts.join('\n\n');
    changes.push('system:moved');
  }
  out.messages = messages;

  if (body.stream != null) out.stream = body.stream;
  for (const key of CHAT_ONLY_FIELDS) if (key in body) dropped.push(key);

  return { body: out, changes, dropped };
}

// ---------------------------------------------------------------- messages → chat

function messagesToChat(body) {
  const changes = [];
  const dropped = [];
  const out = { model: body.model, messages: [] };
  copyCommonNumbers(body, out);

  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens != null) out.max_tokens = maxTokens;

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    out.stop = body.stop_sequences;
    changes.push('stop_sequences->stop');
  }

  if (body.thinking?.type === 'enabled') {
    out.reasoning_effort = budgetToReasoning(body.thinking.budget_tokens);
    changes.push(`thinking->reasoning_effort(${out.reasoning_effort})`);
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((tool) => ({
      type: 'function',
      function: { name: tool?.name, description: tool?.description, parameters: tool?.input_schema || { type: 'object' } },
    }));
    changes.push('tools:nested');
  }

  const choice = body.tool_choice;
  if (choice?.type === 'auto') out.tool_choice = 'auto';
  else if (choice?.type === 'any') out.tool_choice = 'required';
  else if (choice?.type === 'tool' && choice.name) out.tool_choice = { type: 'function', function: { name: choice.name } };

  const systemText = textFromMessagesSystem(body.system);
  if (systemText) {
    out.messages.push({ role: 'system', content: systemText });
    changes.push('system:moved');
  }

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;
    if (typeof msg?.content === 'string') {
      out.messages.push({ role, content: msg.content });
      continue;
    }
    const { images, text, toolUses, toolResults, dropped: blockDropped } = messagesBlocksToChat(msg?.content);
    dropped.push(...blockDropped);
    if (role === 'user' && toolResults.length) {
      // Anthropic 把 tool_result 装在 user 消息里；chat 里它们必须是独立的 role:'tool' 消息
      for (const result of toolResults) {
        out.messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: toolResultToText(result) });
      }
      changes.push('tool_result->tool:message');
      const rest = [...images];
      if (text) rest.push({ type: 'text', text });
      if (rest.length) out.messages.push({ role, content: rest.length === 1 && rest[0].type === 'text' ? rest[0].text : rest });
      continue;
    }
    const message = { role };
    if (images.length) {
      const parts = [...images];
      if (text) parts.push({ type: 'text', text });
      message.content = parts;
    } else if (text) {
      message.content = text;
    } else if (toolUses.length) {
      message.content = null;
    }
    if (toolUses.length) {
      message.tool_calls = toolUses;
      changes.push('tool_use->tool_calls');
    }
    if (message.content !== undefined || message.tool_calls) out.messages.push(message);
  }

  for (const key of ['metadata', 'service_tier']) if (key in body) dropped.push(key);

  return { body: out, changes, dropped };
}

// ---------------------------------------------------------------- chat → responses

function chatToResponses(body) {
  const changes = [];
  const dropped = [];
  const out = { model: body.model };
  copyCommonNumbers(body, out);

  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens != null) out.max_output_tokens = maxTokens;
  if (typeof body.reasoning_effort === 'string') out.reasoning = { effort: body.reasoning_effort };
  if (body.stop != null) dropped.push('stop');

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((tool) => {
      const fn = tool?.function || tool;
      return { type: 'function', name: fn?.name, description: fn?.description, parameters: fn?.parameters || { type: 'object' } };
    });
    changes.push('tools:flattened');
  }
  const choice = body.tool_choice;
  if (choice === 'auto' || choice === 'none' || choice === 'required') out.tool_choice = choice;
  else if (choice?.function?.name) out.tool_choice = { type: 'function', name: choice.function.name };

  let instructions = '';
  const input = [];
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;
    if (role === 'system' || role === 'developer') {
      instructions += (instructions ? '\n\n' : '') + textFromChatContent(msg.content);
      continue;
    }
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: msg.tool_call_id, output: textFromChatContent(msg.content) });
      changes.push('tool:message->function_call_output');
      continue;
    }
    const text = textFromChatContent(msg.content);
    const images = (Array.isArray(msg.content) ? msg.content : [])
      .filter((part) => part?.type === 'image_url')
      .map((part) => ({ type: 'input_image', image_url: part.image_url?.url || '' }));
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const call of msg.tool_calls) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || '{}' });
      }
      changes.push('tool_calls->function_call');
      continue;
    }
    const content = [...images];
    if (text) content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text });
    input.push({ type: 'message', role, content: content.length ? content : [] });
  }
  if (instructions) {
    out.instructions = instructions;
    changes.push('system:moved');
  }
  out.input = input;

  if (body.stream != null) out.stream = body.stream;
  for (const key of CHAT_ONLY_FIELDS) if (key in body && key !== 'store') dropped.push(key);

  return { body: out, changes, dropped };
}

// ---------------------------------------------------------------- responses → chat

function responsesToChat(body) {
  const changes = [];
  const dropped = [];
  const out = { model: body.model, messages: [] };
  copyCommonNumbers(body, out);

  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  for (const key of ['truncation', 'metadata', 'store', 'include', 'parallel_tool_calls', 'text']) {
    if (key in body) dropped.push(key);
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((tool) => tool?.type === 'function')
      .map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters || { type: 'object' } } }));
    changes.push('tools:nested');
  }
  const choice = body.tool_choice;
  if (choice === 'auto' || choice === 'none' || choice === 'required') out.tool_choice = choice;
  else if (choice?.type === 'function' && choice.name) out.tool_choice = { type: 'function', function: { name: choice.name } };

  if (typeof body.instructions === 'string' && body.instructions) {
    out.messages.push({ role: 'system', content: body.instructions });
    changes.push('system:moved');
  }

  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (typeof item === 'string') {
      out.messages.push({ role: 'user', content: item });
      continue;
    }
    switch (item?.type) {
      case 'message': {
        const parts = asArray(item.content);
        const text = parts
          .filter((part) => ['input_text', 'output_text', 'text'].includes(part?.type))
          .map((part) => part.text || '')
          .filter(Boolean)
          .join('');
        const images = parts
          .filter((part) => part?.type === 'input_image')
          .map((part) => ({ type: 'image_url', image_url: { url: part.image_url || '' } }));
        const content = images.length ? [...images, ...(text ? [{ type: 'text', text }] : [])] : text;
        out.messages.push({ role: item.role, content });
        break;
      }
      case 'function_call': {
        const last = out.messages[out.messages.length - 1];
        const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } };
        if (last?.role === 'assistant' && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
        else out.messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        changes.push('function_call->tool_calls');
        break;
      }
      case 'function_call_output':
        out.messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '') });
        changes.push('function_call_output->tool:message');
        break;
      case 'reasoning':
        dropped.push('reasoning:item');
        break;
      default:
        dropped.push(`item:${item?.type || 'unknown'}`);
    }
  }

  return { body: out, changes, dropped };
}

// ---------------------------------------------------------------- 注册表与组合

const DIRECT = {
  'chat->messages': chatToMessages,
  'messages->chat': messagesToChat,
  'chat->responses': chatToResponses,
  'responses->chat': responsesToChat,
};

/** messages↔responses 走 chat 中转：这一对没有直达转换器。 */
const VIA_CHAT = { 'messages->responses': ['messages->chat', 'chat->responses'], 'responses->messages': ['responses->chat', 'chat->messages'] };

export function listConverters() {
  return [...Object.keys(DIRECT), ...Object.keys(VIA_CHAT)];
}

export function isConverter(name) {
  return Object.hasOwn(DIRECT, name) || Object.hasOwn(VIA_CHAT, name);
}

export function describeConverters() {
  return listConverters().map((name) => ({
    name,
    direct: Object.hasOwn(DIRECT, name),
    via: VIA_CHAT[name] ? VIA_CHAT[name].join(' then ') : null,
  }));
}

/**
 * 把请求体从 from 协议转到 to 协议。同协议直接原样返回。
 * @returns {{body:object, changed:boolean, changes:string[], dropped:string[], via:string|null}}
 */
export function convertRequestBody(body, from, to, { options = {} } = {}) {
  if (from === to) return { body, changed: false, changes: [], dropped: [], via: null };
  if (!body || typeof body !== 'object') return { body, changed: false, changes: [], dropped: [], via: null };

  const direct = DIRECT[`${from}->${to}`];
  if (direct) {
    const result = direct(body, options) || {};
    return {
      body: result.body ?? body,
      changed: true,
      changes: result.changes || [],
      dropped: result.dropped || [],
      via: null,
    };
  }

  const path = VIA_CHAT[`${from}->${to}`];
  if (path) {
    const first = DIRECT[path[0]](body, options) || {};
    const second = DIRECT[path[1]](first.body, options) || {};
    return {
      body: second.body ?? first.body,
      changed: true,
      changes: [...(first.changes || []), ...(second.changes || [])],
      dropped: [...(first.dropped || []), ...(second.dropped || [])],
      via: 'chat',
    };
  }

  return { body, changed: false, changes: [], dropped: [], via: null };
}
