import crypto from 'node:crypto';
import { randomBase36, randomHex, renderTemplate } from './template.js';

const SAFE_ID_RE = /^[A-Za-z0-9_.:@|+-]+$/;

/** 会话 ID 必须是安全字符且长度受限，否则视为客户端未提供。 */
export function normalizeSessionId(value, maxLength = 128) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength) return null;
  if (!SAFE_ID_RE.test(text)) return null;
  return text;
}

/** 生成上游风格的会话 ID，如 `ses_` + 26 位十六进制。 */
export function generateId({ prefix = 'ses_', format = 'hex26' } = {}) {
  switch (format) {
    case 'uuid':
      return `${prefix}${crypto.randomUUID()}`;
    case 'hex':
    case 'hex26':
      return `${prefix}${randomHex(26)}`;
    case 'base36':
      return `${prefix}${randomBase36(26)}`;
    case 'short':
      return `${prefix}${randomHex(16)}`;
    default:
      return `${prefix}${randomHex(26)}`;
  }
}

function getByPath(object, path) {
  let cursor = object;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text ?? part.content ?? JSON.stringify(part);
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function firstUserMessage(body) {
  const messages = body?.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message && typeof message === 'object' && message.role === 'user') return message;
    }
    return undefined;
  }
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item && typeof item === 'object' && (item.role === 'user' || item.type === 'message')) return item;
    }
  }
  return undefined;
}

/**
 * 从请求内容推导稳定的会话指纹：system + 首条 user 消息 + 可选 prompt。
 * 同一对话这些内容相对稳定，因此能落回同一个 session ID，提示词缓存才有意义。
 */
export function contentFingerprint(body, options = {}) {
  const {
    fields = ['system', 'system_instruction', 'instructions'],
    includeFirstUserMessage = true,
    includePromptField = true,
  } = options;

  const anchor = [];
  for (const field of fields) {
    const value = getByPath(body, field);
    if (value !== undefined && value !== null) anchor.push(`${field}=${extractText(value)}`);
  }
  if (includeFirstUserMessage) {
    const user = firstUserMessage(body);
    if (user) anchor.push(`firstUser=${extractText(user.content ?? user.text)}`);
  }
  if (includePromptField && typeof body?.prompt === 'string' && body.prompt) {
    anchor.push(`prompt=${body.prompt}`);
  }

  const joined = anchor.filter((part) => part && part.length > 4).join('\n');
  if (!joined.trim()) return null;
  return `k_${crypto.createHash('sha256').update(joined, 'utf8').digest('hex')}`;
}

/**
 * 探测客户端自带的真实会话标识（优先级从高到低）：
 *   1. 入站请求头
 *   2. 请求体会话字段（含 metadata / extra_body 等嵌套位置）
 */
export function findExplicitSession(headers = {}, body = null, options = {}) {
  const { headerNames = [], bodyFields = [] } = options;

  for (const name of headerNames) {
    const value = normalizeSessionId(headers[String(name).toLowerCase()]);
    if (value) return { id: value, source: `header:${String(name).toLowerCase()}` };
  }

  if (!body || typeof body !== 'object') return null;
  for (const field of bodyFields) {
    const value = normalizeSessionId(getByPath(body, field.replace(/^(body|metadata|extra_body)\./, (m) => m)));
    if (value) return { id: value, source: `body:${field}` };
  }
  // 兼容常见嵌套位置
  for (const container of ['metadata', 'meta', 'extra_body', 'extraBody', 'client']) {
    const nested = body[container];
    if (!nested || typeof nested !== 'object') continue;
    for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']) {
      const value = normalizeSessionId(nested[key]);
      if (value) return { id: value, source: `body:${container}.${key}` };
    }
  }
  return null;
}

/**
 * 会话表：显式会话与内容指纹共用一张表，超限或过期自动清理。
 * 显式会话用 `explicit:` 前缀隔离，避免与内容指纹串号。
 */
export class SessionStore {
  constructor({ maxSessions = 512, ttlSeconds = 0 } = {}) {
    this.map = new Map();
    this.maxSessions = Math.max(1, maxSessions);
    this.ttlMs = Math.max(0, ttlSeconds) * 1000;
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.map.size;
  }

  #purgeExpired(now) {
    if (!this.ttlMs) return;
    for (const [key, record] of this.map) {
      if (now - record.lastUsed > this.ttlMs) this.map.delete(key);
    }
  }

  trim(now = Date.now()) {
    this.#purgeExpired(now);
    while (this.map.size > this.maxSessions) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get(key, now = Date.now()) {
    const record = this.map.get(key);
    if (!record) return null;
    if (this.ttlMs && now - record.lastUsed > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return record;
  }

  set(key, record, now = Date.now()) {
    record.lastUsed = now;
    this.map.set(key, record);
    this.trim(now);
    return record;
  }

  clear() {
    this.map.clear();
  }
}

/**
 * 决定本次请求使用哪个会话。
 *
 *   1. 客户端显式会话标识（header / body）—— 真实对话绑定，同一对话内恒定
 *   2. 内容指纹（system + 首条 user 消息）—— 客户端不带会话信息时的回退
 *   3. 都没有 —— 一次性随机 ID（只保证上游不报 400，不参与复用）
 *
 * 返回 { id, key, count, requestId, source }。
 */
export function resolveSession({ headers = {}, body = null, config, store }) {
  const sessionConfig = config.session;
  if (!sessionConfig?.enabled) {
    return { id: null, key: null, count: 0, requestId: null, source: 'disabled' };
  }

  const now = Date.now();
  const explicit = findExplicitSession(headers, body, sessionConfig);

  let key;
  let record;
  let source;

  if (explicit) {
    key = `explicit:${explicit.id}`;
    source = explicit.source;
    record = store.get(key, now);
    if (record) {
      store.hits += 1;
    } else {
      store.misses += 1;
      record = { id: explicit.id, count: 0, createdAt: now, lastUsed: now };
      store.set(key, record, now);
    }
  } else {
    const fingerprint = contentFingerprint(body, sessionConfig.contentHash || {});
    if (fingerprint) {
      key = fingerprint;
      source = 'content-hash';
      record = store.get(key, now);
      if (record) {
        store.hits += 1;
      } else {
        store.misses += 1;
        record = {
          id: generateId({ prefix: sessionConfig.idPrefix, format: sessionConfig.idFormat }),
          count: 0,
          createdAt: now,
          lastUsed: now,
        };
        store.set(key, record, now);
      }
    } else {
      // 无法归因到稳定对话：发一次性 ID，不入表，避免把会话表撑爆
      const id = generateId({ prefix: sessionConfig.idPrefix, format: sessionConfig.idFormat });
      return {
        id,
        key: null,
        count: 1,
        requestId: renderTemplate(sessionConfig.requestIdFormat, {
          session: { id, count: 1 },
          functions: {},
        }),
        source: 'random',
      };
    }
  }

  record.count += 1;
  record.lastUsed = now;

  const requestId = renderTemplate(sessionConfig.requestIdFormat, {
    session: { id: record.id, count: record.count },
    functions: {},
  });

  return {
    id: record.id,
    key,
    count: record.count,
    requestId,
    source,
    createdAt: record.createdAt,
  };
}
