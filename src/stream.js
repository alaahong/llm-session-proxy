/**
 * SSE 流式转码（v0.2.2）。这是整个 v0.2 里风险最高的一块，所以结构刻意简单：
 *
 *   上游 SSE ──解析──▶ 协议事件 ──归一──▶ chat 增量块 ──序列化──▶ 客户端 SSE
 *
 * 中间形式就选 chat 的 `chat.completion.chunk`：三种协议里它的增量粒度最细
 * （content / tool_calls / finish_reason），messages 与 responses 的事件都能无损地
 * 折叠进去；反过来从 chat 块重建另外两家的的事件流，状态机也只有一份。
 *
 * 已知的有损点（刻意为之，不是疏忽）：
 * - Anthropic 的 thinking / signature 增量在转成 chat 时被丢弃（chat 没有标准位）；
 * - messages↔responses 没有直达流，经 chat 形式中转，与请求体转换共用同一取舍。
 *
 * 解析器与状态机都**不碰网络**：调用方喂 Buffer、收要写给客户端的文本。
 */

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

/**
 * 增量 SSE 解析器。喂任意切分的文本，按空行分块；每块产出 { event, data }。
 * `data: [DONE]` 产出 { event: 'done', data: null }。注释行（: ping）忽略。
 */
export function createSseParser(onBlock) {
  let buffer = '';
  const feed = (text) => {
    buffer += text.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handleBlock(block);
      boundary = buffer.indexOf('\n\n');
    }
  };
  const handleBlock = (block) => {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') onBlock('done', null);
    else onBlock(event, data);
  };
  return { feed };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 流式转码器。
 * @param {{from:string, to:string, write:(text:string)=>void}} options
 * @returns {{push:(chunk:Buffer|string)=>void, end:()=>void, stats:object}}
 */
export function createStreamTranscoder({ from, to, write }) {
  if (from === to) throw new Error('createStreamTranscoder: from === to');

  const stats = { events: 0, chunks: 0, dropped: [] };
  const meta = { id: null, model: null, created: Math.floor(Date.now() / 1000) };
  const up = { tools: new Map(), toolCounter: 0, stopReason: null, usage: {}, ended: false };
  const down = {
    started: false,
    textOpen: false,
    blockIndex: 0,
    tools: new Map(),
    toolCounter: 0,
    text: '',
    output: [],
    finish: null,
    usage: {},
    ended: false,
  };

  const header = () => ({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model });

  // ---------------- 上游事件 → chat 增量块 ----------------

  const deltaChunk = (delta) => ({ ...header(), choices: [{ index: 0, delta, finish_reason: null }] });

  const upstreamToChunks = (event, data) => {
    if (from === 'chat') {
      const chunk = safeJson(data);
      if (!chunk) return [];
      if (chunk.id) meta.id = chunk.id;
      if (chunk.model) meta.model = chunk.model;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) {
        up.stopReason = choice.finish_reason;
        // usage 通常在顶层（stream_options.include_usage），有的网关塞在 choice 里，两边都认
        const usage = chunk.usage || choice.usage;
        if (usage) up.usage = usage;
        up.ended = true;
      }
      if (choice?.delta && Object.keys(choice.delta).length) return [deltaChunk(choice.delta)];
      return [];
    }

    if (from === 'messages') {
      const payload = safeJson(data);
      if (!payload) return [];
      switch (event || payload.type) {
        case 'message_start': {
          if (payload.message?.id) meta.id = payload.message.id;
          if (payload.message?.model) meta.model = payload.message.model;
          if (payload.message?.usage?.input_tokens != null) up.usage.prompt_tokens = payload.message.usage.input_tokens;
          return [deltaChunk({ role: 'assistant', content: '' })];
        }
        case 'content_block_start': {
          const block = payload.content_block || {};
          if (block.type === 'tool_use') {
            up.tools.set(payload.index, { id: block.id, name: block.name, args: '' });
          }
          return [];
        }
        case 'content_block_delta': {
          const delta = payload.delta || {};
          if (delta.type === 'text_delta') return [deltaChunk({ content: delta.text || '' })];
          if (delta.type === 'input_json_delta') {
            const tool = up.tools.get(payload.index);
            if (tool) tool.args += delta.partial_json || '';
            return [];
          }
          if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
            stats.dropped.push(delta.type);
            return [];
          }
          stats.dropped.push(`delta:${delta.type || 'unknown'}`);
          return [];
        }
        case 'content_block_stop': {
          const tool = up.tools.get(payload.index);
          if (!tool) return [];
          up.tools.delete(payload.index);
          return [deltaChunk({ tool_calls: [{ index: up.toolCounter++, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args || '{}' } }] })];
        }
        case 'message_delta': {
          if (payload.delta?.stop_reason) up.stopReason = payload.delta.stop_reason;
          if (payload.usage?.output_tokens != null) up.usage.completion_tokens = payload.usage.output_tokens;
          return [];
        }
        case 'message_stop':
          up.ended = true;
          return [];
        default:
          return [];
      }
    }

    // from === 'responses'
    const payload = safeJson(data) || {};
    switch (event || payload.type) {
      case 'response.created':
      case 'response.in_progress': {
        const response = payload.response || {};
        if (response.id) meta.id = response.id;
        if (response.model) meta.model = response.model;
        return [];
      }
      case 'response.output_text.delta':
        return [deltaChunk({ content: payload.delta || '' })];
      case 'response.output_item.added': {
        const item = payload.item || {};
        if (item.type === 'function_call') {
          up.tools.set(item.call_id, { id: item.call_id, name: item.name, args: '' });
        }
        return [];
      }
      case 'response.function_call_arguments.delta': {
        const tool = up.tools.get(payload.call_id || payload.item_id);
        if (tool) tool.args += payload.delta || '';
        return [];
      }
      case 'response.output_item.done': {
        const item = payload.item || {};
        if (item.type !== 'function_call') return [];
        up.tools.delete(item.call_id);
        return [
          deltaChunk({
            tool_calls: [{ index: up.toolCounter++, id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }],
          }),
        ];
      }
      case 'response.completed':
      case 'response.incomplete': {
        if (payload.response?.usage) {
          up.usage.prompt_tokens = payload.response.usage.input_tokens ?? 0;
          up.usage.completion_tokens = payload.response.usage.output_tokens ?? 0;
        }
        up.stopReason = event === 'response.incomplete' ? 'length' : 'stop';
        up.ended = true;
        return [];
      }
      default:
        return [];
    }
  };

  // ---------------- chat 增量块 → 客户端协议 ----------------

  const send = (text) => {
    stats.chunks += 1;
    write(text);
  };
  const sendEvent = (event, payload) => send(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const sendData = (payload) => send(`data: ${JSON.stringify(payload)}\n\n`);

  const ensureUsage = () => {
    down.usage.prompt_tokens = down.usage.prompt_tokens ?? up.usage.prompt_tokens ?? 0;
    down.usage.completion_tokens = down.usage.completion_tokens ?? up.usage.completion_tokens ?? 0;
    return down.usage;
  };

  const emitChunk = (chunk) => {
    const delta = chunk.choices?.[0]?.delta || {};
    if (delta.role && !down.started) {
      down.started = true;
      if (to === 'chat') {
        // chat 的开头块本身就带着这个 delta，发完即止，不能再落一次
        sendData(chunk);
        return;
      }
      if (to === 'messages') {
        sendEvent('message_start', {
          type: 'message_start',
          message: {
            id: chunk.id, type: 'message', role: 'assistant', model: chunk.model,
            content: [], stop_sequence: null,
            usage: { input_tokens: up.usage.prompt_tokens ?? 0, output_tokens: 0 },
          },
        });
      } else {
        sendEvent('response.created', { type: 'response.created', response: { id: chunk.id, status: 'in_progress', model: chunk.model, output: [] } });
      }
      // 刻意不 return：有的上游把首段文本和 role 放进同一个 delta，接着往下走
    }
    if (!down.started) {
      down.started = true;
      if (to === 'chat') sendData({ ...header(), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      else if (to === 'messages') sendEvent('message_start', { type: 'message_start', message: { id: chunk.id, type: 'message', role: 'assistant', model: chunk.model, content: [], stop_sequence: null, usage: { input_tokens: up.usage.prompt_tokens ?? 0, output_tokens: 0 } } });
      else sendEvent('response.created', { type: 'response.created', response: { id: chunk.id, status: 'in_progress', model: chunk.model, output: [] } });
    }

    if (to === 'chat') {
      sendData(chunk);
      return;
    }

    // 文本增量
    if (typeof delta.content === 'string' && delta.content) {
      down.text += delta.content;
      if (to === 'messages') {
        if (!down.textOpen) {
          down.textOpen = true;
          sendEvent('content_block_start', { type: 'content_block_start', index: down.blockIndex, content_block: { type: 'text', text: '' } });
        }
        sendEvent('content_block_delta', { type: 'content_block_delta', index: down.blockIndex, delta: { type: 'text_delta', text: delta.content } });
      } else {
        if (!down.textOpen) {
          down.textOpen = true;
          sendEvent('response.output_item.added', { type: 'response.output_item.added', output_index: down.blockIndex, item: { type: 'message', role: 'assistant' } });
        }
        sendEvent('response.output_text.delta', { type: 'response.output_text.delta', delta: delta.content });
      }
      return;
    }

    // 工具调用增量
    for (const call of delta.tool_calls || []) {
      const fn = call.function || {};
      let tool = down.tools.get(call.index);
      if (!tool) {
        tool = { blockIndex: ++down.blockIndex, id: call.id, name: fn.name || '', args: '', closed: false };
        down.tools.set(call.index, tool);
        if (to === 'messages') {
          sendEvent('content_block_start', { type: 'content_block_start', index: tool.blockIndex, content_block: { type: 'tool_use', id: call.id, name: tool.name, input: {} } });
        } else {
          sendEvent('response.output_item.added', { type: 'response.output_item.added', output_index: tool.blockIndex, item: { type: 'function_call', call_id: call.id, name: tool.name, arguments: '' } });
        }
      }
      if (fn.arguments) {
        tool.args += fn.arguments;
        if (to === 'messages') {
          sendEvent('content_block_delta', { type: 'content_block_delta', index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: fn.arguments } });
        } else {
          sendEvent('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: tool.id, delta: fn.arguments });
        }
      }
    }
  };

  const closeBlock = (index) => sendEvent('content_block_stop', { type: 'content_block_stop', index });

  /** 收尾：关掉没关的块，发终结事件与 [DONE]。幂等。 */
  const finalize = () => {
    if (down.ended) return;
    down.ended = true;
    const finish = up.stopReason ? (from === 'messages' ? STOP_TO_FINISH[up.stopReason] || 'stop' : up.stopReason) : 'stop';
    const usage = ensureUsage();
    down.finish = down.finish || finish;

    if (to === 'chat') {
      const tail = { ...header(), choices: [{ index: 0, delta: {}, finish_reason: down.finish }] };
      if (up.usage.prompt_tokens != null || up.usage.completion_tokens != null) tail.usage = usage;
      sendData(tail);
      send('data: [DONE]\n\n');
      return;
    }

    if (to === 'messages') {
      if (down.textOpen) {
        down.textOpen = false;
        closeBlock(down.blockIndex);
      }
      for (const tool of down.tools.values()) {
        if (!tool.closed) {
          tool.closed = true;
          closeBlock(tool.blockIndex);
        }
      }
      sendEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: FINISH_TO_STOP[down.finish] || 'end_turn', stop_sequence: null },
        usage: { output_tokens: usage.completion_tokens ?? 0 },
      });
      sendEvent('message_stop', { type: 'message_stop' });
      return;
    }

    // to === 'responses'：拼一个完整的 response 对象收尾
    const output = [];
    if (down.text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: down.text }] });
    for (const tool of down.tools.values()) {
      output.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.args || '{}' });
    }
    sendEvent('response.completed', {
      type: 'response.completed',
      response: {
        id: meta.id, status: down.finish === 'length' ? 'incomplete' : 'completed', model: meta.model, output,
        usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
      },
    });
  };

  const parser = createSseParser((event, data) => {
    stats.events += 1;
    if (event === 'done' || up.ended) {
      finalize();
      return;
    }
    for (const chunk of upstreamToChunks(event, data)) emitChunk(chunk);
    if (up.ended) finalize();
  });

  return {
    push(chunk) {
      if (down.ended) return;
      parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    },
    end() {
      finalize();
    },
    stats,
  };
}
