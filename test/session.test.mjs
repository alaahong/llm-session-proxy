import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, deepMerge, parseUpstream, buildConfig, parseJsonLoose } from '../src/config.js';
import {
  SessionStore,
  contentFingerprint,
  findExplicitSession,
  generateId,
  normalizeSessionId,
  resolveSession,
} from '../src/session.js';
import { renderTemplate } from '../src/template.js';

const config = () => deepMerge(DEFAULT_CONFIG, {});

test('normalizeSessionId 只接受安全字符且限制长度', () => {
  assert.equal(normalizeSessionId('abc-123_XY.z'), 'abc-123_XY.z');
  assert.equal(normalizeSessionId('  spaced  '), 'spaced');
  assert.equal(normalizeSessionId('bad value'), null);
  assert.equal(normalizeSessionId('bad\nvalue'), null);
  assert.equal(normalizeSessionId(''), null);
  assert.equal(normalizeSessionId(undefined), null);
  assert.equal(normalizeSessionId('x'.repeat(129)), null);
});

test('generateId 按格式生成带前缀的 ID', () => {
  const hex = generateId({ prefix: 'ses_', format: 'hex26' });
  assert.match(hex, /^ses_[0-9a-f]{26}$/);
  const uuid = generateId({ prefix: '', format: 'uuid' });
  assert.match(uuid, /^[0-9a-f-]{36}$/);
});

test('contentFingerprint 对同一段对话稳定，内容一变就变', () => {
  const a = { model: 'glm-5.3', system: '你是助手', messages: [{ role: 'user', content: '你好' }] };
  const b = { model: 'glm-5.3', system: '你是助手', messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }] };
  const c = { model: 'glm-5.3', system: '你是助手', messages: [{ role: 'user', content: '再见' }] };

  const fa = contentFingerprint(a, config().session.contentHash);
  const fb = contentFingerprint(b, config().session.contentHash);
  const fc = contentFingerprint(c, config().session.contentHash);

  assert.ok(fa, '应当能算出指纹');
  assert.equal(fa, fb, '后续轮次追加消息不应改变指纹');
  assert.notEqual(fa, fc, '换了首条用户消息应当换指纹');
});

test('contentFingerprint 在没有任何锚点内容时返回 null', () => {
  assert.equal(contentFingerprint({ messages: [] }, config().session.contentHash), null);
  assert.equal(contentFingerprint({}, config().session.contentHash), null);
});

test('findExplicitSession 支持请求头与请求体字段', () => {
  const cfg = config().session;
  assert.deepEqual(findExplicitSession({ 'x-session-id': 'sess-1' }, null, cfg), {
    id: 'sess-1',
    source: 'header:x-session-id',
  });
  assert.deepEqual(findExplicitSession({}, { conversation_id: 'conv-9' }, cfg)?.id, 'conv-9');
  assert.deepEqual(findExplicitSession({}, { metadata: { sessionId: 'meta-7' } }, cfg)?.id, 'meta-7');
  assert.equal(findExplicitSession({}, { nothing: 1 }, cfg), null);
});

test('显式会话标识优先，并在同一对话内保持稳定', () => {
  const store = new SessionStore(config().session);
  const cfg = config();
  const body = { system: 's', messages: [{ role: 'user', content: 'hi' }] };
  const headers = { 'x-opencode-session': 'fixed-session' };

  const first = resolveSession({ headers, body, config: cfg, store });
  const second = resolveSession({ headers, body: { ...body }, config: cfg, store });

  assert.equal(first.id, 'fixed-session');
  assert.equal(second.id, 'fixed-session');
  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(second.requestId, 'msg_2');
  assert.equal(first.source, 'header:x-opencode-session');
  assert.equal(store.size, 1);
});

test('没有显式会话时回退到内容指纹，且同一对话复用同一个生成的 ID', () => {
  const store = new SessionStore(config().session);
  const cfg = config();
  const body = { system: 'you are helpful', messages: [{ role: 'user', content: 'first question' }] };

  const first = resolveSession({ headers: {}, body, config: cfg, store });
  const second = resolveSession({
    headers: {},
    body: { ...body, messages: [...body.messages, { role: 'assistant', content: 'ok' }] },
    config: cfg,
    store,
  });

  assert.equal(first.source, 'content-hash');
  assert.equal(first.id, second.id);
  assert.equal(second.count, 2);
  assert.match(first.id, /^ses_[0-9a-f]{26}$/);
});

test('完全无法归因时发一次性随机 ID，且不污染会话表', () => {
  const store = new SessionStore(config().session);
  const cfg = config();
  const first = resolveSession({ headers: {}, body: {}, config: cfg, store });
  const second = resolveSession({ headers: {}, body: {}, config: cfg, store });

  assert.equal(first.source, 'random');
  assert.notEqual(first.id, second.id);
  assert.equal(store.size, 0);
});

test('session.enabled 为 false 时彻底不注入', () => {
  const store = new SessionStore(config().session);
  const cfg = deepMerge(config(), { session: { enabled: false } });
  const result = resolveSession({ headers: { 'x-session-id': 'x' }, body: {}, config: cfg, store });
  assert.equal(result.id, null);
  assert.equal(result.requestId, null);
});

test('SessionStore 超出上限时淘汰最旧的记录', () => {
  const store = new SessionStore({ maxSessions: 2 });
  store.set('a', { id: 'a', count: 1 });
  store.set('b', { id: 'b', count: 1 });
  store.set('c', { id: 'c', count: 1 });
  assert.equal(store.size, 2);
  assert.equal(store.get('a'), null);
  assert.ok(store.get('c'));
});

test('SessionStore 支持按 TTL 过期', () => {
  const store = new SessionStore({ maxSessions: 10, ttlSeconds: 60 });
  const now = Date.now();
  store.set('a', { id: 'a', count: 1 }, now);
  assert.ok(store.get('a', now + 1000));
  assert.equal(store.get('a', now + 61000), null);
});

test('模板引擎支持内置函数与嵌套取值', () => {
  const ctx = {
    session: { id: 'ses_1', count: 3 },
    env: { MY_VAR: 'hello' },
    functions: { uuid: () => 'uuid-fixed' },
  };
  assert.equal(renderTemplate('{{session.id}}#{{session.count}}', ctx), 'ses_1#3');
  assert.equal(renderTemplate('{{env.MY_VAR}}', ctx), 'hello');
  assert.equal(renderTemplate('{{uuid}}', ctx), 'uuid-fixed');
  assert.equal(renderTemplate('{{missing.path}}', ctx), '');
  assert.equal(renderTemplate('没有占位符', ctx), '没有占位符');
});

test('parseUpstream 接受完整 URL 与裸 host', () => {
  assert.deepEqual(parseUpstream('https://opencode.ai'), {
    protocol: 'https',
    host: 'opencode.ai',
    port: null,
    basePath: '',
  });
  assert.deepEqual(parseUpstream('api.example.com:8443'), {
    protocol: 'https',
    host: 'api.example.com',
    port: 8443,
    basePath: '',
  });
  assert.equal(parseUpstream('http://127.0.0.1:11434/v1/').basePath, '/v1');
});

test('parseJsonLoose 允许注释与尾随逗号', () => {
  const parsed = parseJsonLoose(`{
    // 行注释
    "a": 1, /* 块注释 */
    "b": "http://example.com//path",
    "c": [1, 2,],
  }`);
  assert.equal(parsed.a, 1);
  assert.equal(parsed.b, 'http://example.com//path');
  assert.deepEqual(parsed.c, [1, 2]);
});

test('buildConfig 的优先级：默认值 < 环境变量 < 命令行', () => {
  const built = buildConfig({
    env: { PROXY_PORT: '7000', OPENCODE_UA: 'from-env/1.0' },
    flags: { listen: { port: 8000 } },
  });
  assert.equal(built.listen.port, 8000);
  assert.equal(built.userAgent, 'from-env/1.0');
  assert.equal(built.upstream.host, 'opencode.ai');
});

test('buildConfig 在端口非法时抛错', () => {
  assert.throws(() => buildConfig({ flags: { listen: { port: 99999 } } }), /listen\.port/);
});
