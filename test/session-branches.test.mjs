import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import {
  SessionStore,
  contentFingerprint,
  findExplicitSession,
  generateId,
  normalizeSessionId,
  resolveSession,
} from '../src/session.js';

/**
 * 会话 ID 归属的分支覆盖。
 *
 * session.test.mjs 覆盖的是「同一段对话拿到同一个 ID」，这里补的是**来源判定本身的边缘形态**：
 * 三种协议（chat / messages / responses）的正文位置不同、分段内容可以是字符串也可以是对象、
 * 显式标识可能藏在请求头、请求体根、metadata、meta、extra_body、client 等各种位置，
 * 以及指纹取不到时必须退到随机而不是报错。
 *
 * 判据统一：**会话 ID 的来源必须可追溯**——显式标识 > 内容指纹 > 随机，
 * 三种都要稳定可复现；指纹取不到就退到随机，**不许拿不到就报错**
 * （客户端不带会话信息是常态，不是异常）。
 */

/** 默认会话配置（与 buildConfig 出来的形状一致）。 */
function sessionConfig(overrides = {}) {
  return deepMerge(DEFAULT_CONFIG, { session: overrides });
}

/** 默认指纹参数：system + 首条 user 消息 + prompt。 */
const FINGERPRINT = {
  fields: ['system', 'system_instruction', 'instructions'],
  includeFirstUserMessage: true,
  includePromptField: true,
};

// ---------------------------------------------------------------- ID 生成

test('generateId 支持 base36 / short / 未知格式三种分支', () => {
  assert.match(generateId({ prefix: 'ses_', format: 'base36' }), /^ses_[0-9a-z]{26}$/);
  assert.match(generateId({ prefix: 'ses_', format: 'short' }), /^ses_[0-9a-f]{16}$/);
  assert.match(
    generateId({ prefix: 'ses_', format: 'not-a-known-format' }),
    /^ses_[0-9a-f]{26}$/,
    '未知格式退到 hex26，而不是抛错',
  );
  assert.match(generateId({ prefix: 'k_', format: 'hex' }), /^k_[0-9a-f]{26}$/);
});

// ---------------------------------------------------------------- 正文抽取

test('extractText：content 是数组时逐个元素取文本', () => {
  const fingerprint = contentFingerprint(
    {
      messages: [
        {
          role: 'user',
          content: [
            '纯字符串片段',
            { type: 'text', text: '带 text 的片段' },
            { type: 'image', content: '带 content 的片段' },
            { type: 'tool_use', id: 'x' },
            42,
            null,
          ],
        },
      ],
    },
    FINGERPRINT,
  );

  assert.ok(fingerprint, '应当能算出指纹');
  assert.match(fingerprint, /^k_[0-9a-f]{64}$/);
});

test('extractText：content 是对象时整体序列化，形状不同指纹就不同', () => {
  const a = contentFingerprint({ messages: [{ role: 'user', content: { kind: 'image', url: 'u' } }] }, FINGERPRINT);
  const b = contentFingerprint({ messages: [{ role: 'user', content: { kind: 'image', url: 'v' } }] }, FINGERPRINT);

  assert.ok(a);
  assert.notEqual(a, b, '内容不同指纹必须不同');
});

test('extractText：content 缺省时该条消息不贡献指纹内容', () => {
  // user 消息没有 content 也没有 text：这条消息不提供锚点
  assert.equal(contentFingerprint({ messages: [{ role: 'user' }] }, FINGERPRINT), null);
});

// ---------------------------------------------------------------- 首条 user 消息

test('firstUserMessage：responses 协议的正文在 body.input 里', () => {
  const fingerprint = contentFingerprint(
    { input: [{ role: 'user', content: 'responses 形态的问题' }] },
    FINGERPRINT,
  );

  assert.ok(fingerprint, 'responses 形态也必须能算出指纹');
});

test('firstUserMessage：input 里 type=message 的条目也算用户消息', () => {
  const withType = contentFingerprint({ input: [{ type: 'message', role: 'user', content: 'x' }] }, FINGERPRINT);
  const withoutType = contentFingerprint({ input: [{ type: 'tool_result', content: 'x' }] }, FINGERPRINT);

  assert.ok(withType);
  assert.equal(withoutType, null, '既不是 user 也不是 message 的条目不算锚点');
});

test('firstUserMessage：messages 里没有 user 消息时仍然去看 input', () => {
  // 回归：早退的 bug —— messages 是数组但里面没有 user 消息时，
  // 曾经直接 return undefined，responses 形态的 input 就被跳过了。
  const mixed = contentFingerprint(
    { messages: [{ role: 'assistant', content: 'hi' }], input: [{ role: 'user', content: '真正的用户消息' }] },
    FINGERPRINT,
  );
  const onlyInput = contentFingerprint({ input: [{ role: 'user', content: '真正的用户消息' }] }, FINGERPRINT);

  assert.ok(mixed, '两种字段同时出现时也必须能用上 input 里的用户消息');
  assert.equal(mixed, onlyInput, '锚点一致就该算出同一个指纹');
});

test('firstUserMessage：messages 数组里全是非用户消息时返回空', () => {
  assert.equal(contentFingerprint({ messages: [{ role: 'system', content: 's' }] }, FINGERPRINT), null);
});

// ---------------------------------------------------------------- prompt 字段

test('contentFingerprint：prompt 字段参与指纹', () => {
  const withPrompt = contentFingerprint({ prompt: '画一只猫' }, FINGERPRINT);
  const otherPrompt = contentFingerprint({ prompt: '画一只狗' }, FINGERPRINT);

  assert.ok(withPrompt, 'prompt 也算锚点');
  assert.notEqual(withPrompt, otherPrompt, 'prompt 不同指纹必须不同');
});

test('contentFingerprint：关掉 prompt 与首条用户消息后就没有锚点', () => {
  const options = { fields: [], includeFirstUserMessage: false, includePromptField: false };
  assert.equal(contentFingerprint({ prompt: 'x', messages: [{ role: 'user', content: 'y' }] }, options), null);
});

// ---------------------------------------------------------------- 显式标识

test('findExplicitSession：请求体根上的字段按 bodyFields 顺序找', () => {
  const cfg = sessionConfig().session;

  assert.deepEqual(findExplicitSession({}, { session_id: 's1', conversation_id: 'c1' }, cfg), {
    id: 's1',
    source: 'body:session_id',
  });
  assert.deepEqual(findExplicitSession({}, { conversationId: 'c2' }, cfg), {
    id: 'c2',
    source: 'body:conversationId',
  });
});

test('findExplicitSession：嵌套容器里的标识也能认出来', () => {
  const cfg = sessionConfig().session;

  assert.equal(findExplicitSession({}, { metadata: { session_id: 'm1' } }, cfg)?.source, 'body:metadata.session_id');
  assert.equal(findExplicitSession({}, { meta: { sessionId: 'm2' } }, cfg)?.source, 'body:meta.sessionId');
  assert.equal(findExplicitSession({}, { extra_body: { thread_id: 't1' } }, cfg)?.source, 'body:extra_body.thread_id');
  assert.equal(findExplicitSession({}, { extraBody: { conversationId: 'e1' } }, cfg)?.source, 'body:extraBody.conversationId');
  assert.equal(findExplicitSession({}, { client: { threadId: 'c1' } }, cfg)?.source, 'body:client.threadId');
});

test('findExplicitSession：嵌套位置也支持点路径', () => {
  const cfg = sessionConfig().session;
  assert.equal(findExplicitSession({}, { metadata: { session_id: 'dot-1' } }, cfg)?.id, 'dot-1');
});

test('findExplicitSession：点路径的中间一段不是对象时按取不到处理', () => {
  // 字段路径写成 'meta.prompt'，而 body.meta 是字符串：取不到就当没有
  const fingerprint = contentFingerprint({ meta: 'not-an-object' }, { fields: ['meta.prompt'], includeFirstUserMessage: false, includePromptField: false });
  assert.equal(fingerprint, null);
});

test('findExplicitSession：嵌套容器里没有会话字段时继续找下一个容器', () => {
  const cfg = sessionConfig().session;
  assert.equal(findExplicitSession({}, { metadata: { foo: 'bar' }, client: { thread_id: 'c9' } }, cfg)?.id, 'c9');
  assert.equal(findExplicitSession({}, { metadata: { foo: 'bar' } }, cfg), null);
});

test('findExplicitSession：请求头优先于请求体', () => {
  const cfg = sessionConfig().session;
  const found = findExplicitSession({ 'x-opencode-session': 'from-header' }, { session_id: 'from-body' }, cfg);

  assert.deepEqual(found, { id: 'from-header', source: 'header:x-opencode-session' });
});

test('findExplicitSession：不带会话信息时返回 null，而不是报错', () => {
  const cfg = sessionConfig().session;

  assert.equal(findExplicitSession({}, null, cfg), null);
  assert.equal(findExplicitSession({}, {}, cfg), null);
  assert.equal(findExplicitSession({}, { metadata: 'not-an-object' }, cfg), null);
});

test('normalizeSessionId：数字 ID 也接受，但超长或危险字符一律拒绝', () => {
  assert.equal(normalizeSessionId(12345), '12345');
  assert.equal(normalizeSessionId('a'.repeat(128)), 'a'.repeat(128));
  assert.equal(normalizeSessionId('a'.repeat(129)), null, '超长视为客户端没提供');
  assert.equal(normalizeSessionId('a b'), null, '含空格视为不安全');
  assert.equal(normalizeSessionId(true), null, '非字符串非数字一律拒绝');
});

// ---------------------------------------------------------------- 会话表

test('SessionStore.clear 清空整张表', () => {
  const store = new SessionStore({ maxSessions: 10 });
  store.set('a', { id: 'a', count: 1 });
  store.set('b', { id: 'b', count: 1 });
  assert.equal(store.size, 2);

  store.clear();

  assert.equal(store.size, 0);
  assert.equal(store.get('a'), null);
});

test('SessionStore：TTL 到期的记录会被清掉，clear 之后也不再复活', () => {
  const store = new SessionStore({ maxSessions: 10, ttlSeconds: 60 });
  const now = Date.now();
  store.set('a', { id: 'a', count: 1 }, now);

  assert.ok(store.get('a', now + 1000));
  assert.equal(store.get('a', now + 61000), null, '过期即失效');
  assert.equal(store.size, 0, '过期的记录会被顺手删掉');
});

test('SessionStore：写入新记录时顺手清掉过期的旧记录', () => {
  const store = new SessionStore({ maxSessions: 10, ttlSeconds: 60 });
  const now = Date.now();
  store.set('old', { id: 'old', count: 1 }, now);

  // 过了 TTL 之后写入另一条：清理时旧的那条会被顺手删掉
  store.set('new', { id: 'new', count: 1 }, now + 61000);

  assert.equal(store.get('old'), null);
  assert.ok(store.get('new'));
  assert.equal(store.size, 1);
});

// ---------------------------------------------------------------- 来源可追溯

test('resolveSession：四种来源都能从返回值里看出来', () => {
  const cfg = sessionConfig();
  const store = new SessionStore(cfg.session);

  const explicit = resolveSession({
    headers: { 'x-opencode-session': 'sid-1' },
    body: {},
    config: cfg,
    store,
  });
  const hashed = resolveSession({
    headers: {},
    body: { system: 's', messages: [{ role: 'user', content: 'hello' }] },
    config: cfg,
    store,
  });
  const random = resolveSession({ headers: {}, body: {}, config: cfg, store });

  assert.equal(explicit.source, 'header:x-opencode-session');
  assert.equal(hashed.source, 'content-hash');
  assert.equal(random.source, 'random');
  assert.equal(random.key, null, '随机 ID 不入表，也不该有 key');
  assert.equal(store.size, 2, '显式与指纹各占一格，随机不入表');
});

test('resolveSession：显式会话在表里的 key 与指纹会话互不串号', () => {
  const cfg = sessionConfig();
  const store = new SessionStore(cfg.session);
  const body = { system: 's', messages: [{ role: 'user', content: 'hello' }] };

  const explicit = resolveSession({ headers: { 'x-session-id': 'shared' }, body, config: cfg, store });
  const hashed = resolveSession({ headers: {}, body, config: cfg, store });

  assert.notEqual(explicit.key, hashed.key, '两种来源必须用不同的 key');
  assert.equal(explicit.key, 'explicit:shared');
  assert.match(hashed.key, /^k_[0-9a-f]{64}$/);
});

test('resolveSession：会话关掉时什么都不注入，也不报错', () => {
  const cfg = sessionConfig({ enabled: false });
  const store = new SessionStore(cfg.session);

  const result = resolveSession({ headers: { 'x-session-id': 'x' }, body: {}, config: cfg, store });

  assert.deepEqual(result, { id: null, key: null, count: 0, requestId: null, source: 'disabled' });
  assert.equal(store.size, 0);
});

test('resolveSession：contentHash 整个写错时退回默认锚点，不报错', () => {
  const cfg = sessionConfig({ contentHash: null });
  const store = new SessionStore(cfg.session);
  const body = { system: 's', messages: [{ role: 'user', content: 'hello' }] };

  const result = resolveSession({ headers: {}, body, config: cfg, store });

  assert.equal(result.source, 'content-hash', '退回默认锚点后仍能算出指纹');
  assert.ok(result.id);
});
