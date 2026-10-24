import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COPILOT_API_VERSION,
  PROVIDER_TYPES,
  apiKeyFromEnv,
  credentialHeaderSpec,
  credentialSources,
  describeProvider,
  describeUpstreams,
  normalizeProvider,
  normalizeUpstreams,
  parseProviderBaseUrl,
  providerHeaders,
  resolveUpstream,
  resolveWire,
  upstreamPathFor,
} from '../src/upstreams.js';

// ---------------------------------------------------------------- 归一化

test('provider 类型不合法时原样返回，交给校验报错', () => {
  assert.equal(normalizeProvider('x', 'not-an-object'), 'not-an-object');
  assert.equal(normalizeProvider('x', null), null);
});

test('归一化补齐默认端点路径与 wire', () => {
  const provider = normalizeProvider('openai', { type: 'openai', baseUrl: 'https://api.openai.com/v1' });
  assert.equal(provider.name, 'openai');
  assert.deepEqual(provider.wire, ['chat', 'responses']);
  assert.equal(provider.paths.chat, '/chat/completions');
  assert.equal(provider.paths.responses, '/responses');
});

test('baseUrl 末尾的斜杠被去掉', () => {
  const provider = normalizeProvider('x', { type: 'openai', baseUrl: 'https://api.openai.com/v1/' });
  assert.equal(provider.baseUrl, 'https://api.openai.com/v1');
});

test('provider 自带的 paths 覆盖类型默认值', () => {
  const provider = normalizeProvider('x', {
    type: 'openai',
    baseUrl: 'https://x.example',
    paths: { chat: '/custom/chat' },
  });
  assert.equal(provider.paths.chat, '/custom/chat');
  assert.equal(provider.paths.responses, '/responses', '没覆盖的保留默认值');
});

test('归一化池：providers 表与 routes 都被处理', () => {
  const pool = normalizeUpstreams({
    providers: { a: { type: 'openai', baseUrl: 'https://a.example' } },
    routes: [{ model: 'gpt-5', upstream: 'a' }],
    default: 'a',
  });
  assert.equal(pool.providers.a.name, 'a');
  assert.equal(pool.routes[0].upstream, 'a');
  assert.equal(pool.default, 'a');
  assert.equal(pool.enabled, true);
});

// ---------------------------------------------------------------- 选上游

test('选上游：桶里点名优先于规则与默认', () => {
  const pool = normalizeUpstreams({
    providers: {
      a: { type: 'openai', baseUrl: 'https://a.example' },
      b: { type: 'openai', baseUrl: 'https://b.example' },
    },
    routes: [{ model: 'gpt-', upstream: 'a' }],
    default: 'b',
  });
  const picked = resolveUpstream({ model: 'gpt-5', bucketUpstream: 'a', upstreamConfig: pool });
  assert.equal(picked.name, 'a');
  assert.equal(picked.source, 'bucket');
});

test('选上游：桶里没点名时按模型前缀查规则', () => {
  const pool = normalizeUpstreams({
    providers: {
      a: { type: 'openai', baseUrl: 'https://a.example' },
      b: { type: 'openai', baseUrl: 'https://b.example' },
    },
    routes: [{ model: 'gpt-', upstream: 'a' }],
    default: 'b',
  });
  const picked = resolveUpstream({ model: 'gpt-5', bucketUpstream: null, upstreamConfig: pool });
  assert.equal(picked.name, 'a');
  assert.equal(picked.source, 'rule');
});

test('选上游：规则不命中时用默认上游', () => {
  const pool = normalizeUpstreams({
    providers: { b: { type: 'openai', baseUrl: 'https://b.example' } },
    routes: [{ model: 'gpt-', upstream: 'b' }],
    default: 'b',
  });
  const picked = resolveUpstream({ model: 'claude-3', bucketUpstream: null, upstreamConfig: pool });
  assert.equal(picked.name, 'b');
  assert.equal(picked.source, 'default');
});

test('选上游：全都不命中返回 null（回退到旧 upstream）', () => {
  const picked = resolveUpstream({ model: 'x', bucketUpstream: null, upstreamConfig: { providers: {} } });
  assert.equal(picked.name, null);
  assert.equal(picked.source, 'none');
});

test('选上游：点名了但池里没有这个 provider 时标 missing', () => {
  const pool = normalizeUpstreams({ providers: {} });
  const picked = resolveUpstream({ model: 'x', bucketUpstream: 'nope', upstreamConfig: pool });
  assert.equal(picked.name, 'nope');
  assert.equal(picked.missing, true);
});

// ---------------------------------------------------------------- wire 判定

test('Copilot：gpt-5 家族与 Codex 变体走 responses，其余走 chat', () => {
  const provider = normalizeProvider('copilot', { type: 'copilot', baseUrl: 'https://api.githubcopilot.com' });
  assert.equal(resolveWire(provider, 'gpt-5').wire, 'responses');
  assert.equal(resolveWire(provider, 'gpt-5.1').wire, 'responses');
  assert.equal(resolveWire(provider, 'codex-mini').wire, 'responses');
  assert.equal(resolveWire(provider, 'gpt-4o').wire, 'chat');
  assert.equal(resolveWire(provider, 'claude-sonnet-4.6').wire, 'chat');
});

test('Copilot：显式的 modelWire 覆盖内建判定', () => {
  const provider = normalizeProvider('copilot', {
    type: 'copilot',
    baseUrl: 'https://api.githubcopilot.com',
    modelWire: { 'gpt-4o': 'responses' },
  });
  assert.equal(resolveWire(provider, 'gpt-4o').wire, 'responses');
  assert.equal(resolveWire(provider, 'gpt-4o').source, 'modelWire');
});

test('wire：provider 声明多个时取第一个', () => {
  const provider = normalizeProvider('x', { type: 'openai', baseUrl: 'https://x.example' });
  assert.equal(resolveWire(provider, 'any').wire, 'chat');
});

// ---------------------------------------------------------------- 路径

test('路径占位符会被替换', () => {
  const provider = normalizeProvider('gemini', { type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' });
  const path = upstreamPathFor(provider, 'gemini', { model: 'gemini-3.5-flash', stream: false });
  assert.equal(path, '/v1beta/models/gemini-3.5-flash:generateContent');
});

test('Gemini 流式端点自动加 alt=sse', () => {
  const provider = normalizeProvider('gemini', { type: 'gemini', baseUrl: 'https://x.example' });
  const path = upstreamPathFor(provider, 'gemini', { model: 'gemini-3.5-flash', stream: true });
  assert.ok(path.includes('streamGenerateContent'));
  assert.ok(path.includes('alt=sse'));
});

test('provider 没有该 wire 的路径时返回 null', () => {
  const provider = normalizeProvider('anthropic', { type: 'anthropic', baseUrl: 'https://x.example' });
  assert.equal(upstreamPathFor(provider, 'chat', {}), null);
});

// ---------------------------------------------------------------- 凭据

test('凭据来源：环境变量按逗号拆成多个候选', () => {
  const provider = normalizeProvider('x', {
    type: 'openai',
    baseUrl: 'https://x.example',
    auth: { env: 'A_KEY, B_KEY ,C_KEY' },
  });
  assert.deepEqual(credentialSources(provider), [
    { kind: 'env', name: 'A_KEY' },
    { kind: 'env', name: 'B_KEY' },
    { kind: 'env', name: 'C_KEY' },
  ]);
});

test('apiKeyFromEnv 按顺序取第一个非空的', () => {
  const provider = normalizeProvider('x', {
    type: 'openai',
    baseUrl: 'https://x.example',
    auth: { env: 'FIRST,SECOND' },
  });
  assert.equal(apiKeyFromEnv(provider, { SECOND: 'b' }), 'b');
  assert.equal(apiKeyFromEnv(provider, { FIRST: 'a', SECOND: 'b' }), 'a');
  assert.equal(apiKeyFromEnv(provider, {}), null);
});

test('凭据头：默认 Authorization + Bearer，Gemini 用 x-goog-api-key', () => {
  const openai = normalizeProvider('x', { type: 'openai', baseUrl: 'https://x.example', auth: { env: 'K' } });
  assert.deepEqual(credentialHeaderSpec(openai), { header: 'authorization', prefix: 'Bearer ' });

  const gemini = normalizeProvider('g', { type: 'gemini', baseUrl: 'https://x.example', auth: { env: 'K' } });
  assert.deepEqual(credentialHeaderSpec(gemini), { header: 'x-goog-api-key', prefix: '' });
});

test('凭据头可以被显式指定', () => {
  const provider = normalizeProvider('x', {
    type: 'custom',
    baseUrl: 'https://x.example',
    auth: { env: 'K', header: 'X-Api-Key', prefix: '' },
  });
  assert.deepEqual(credentialHeaderSpec(provider), { header: 'x-api-key', prefix: '' });
});

// ---------------------------------------------------------------- 固定头

test('Copilot 的必需头自动补齐', () => {
  const provider = normalizeProvider('copilot', { type: 'copilot', baseUrl: 'https://api.githubcopilot.com' });
  const headers = providerHeaders(provider);
  assert.equal(headers['copilot-integration-id'], 'copilot-developer-cli');
  assert.ok(headers['editor-version']);
  assert.ok(headers['editor-plugin-version']);
  assert.ok(headers['user-agent']);
  // 2022-11-28 是 api.github.com 的版本，发给 Copilot API 会 400 invalid apiVersion
  assert.equal(headers['x-github-api-version'], COPILOT_API_VERSION);
  assert.equal(COPILOT_API_VERSION, '2026-08-01');
});

test('Copilot 的固定头可以被 provider.headers 覆盖', () => {
  const provider = normalizeProvider('copilot', {
    type: 'copilot',
    baseUrl: 'https://api.githubcopilot.com',
    headers: { 'Copilot-Integration-Id': 'my-integration' },
  });
  assert.equal(providerHeaders(provider)['copilot-integration-id'], 'my-integration');
});

test('非 Copilot 的 provider 不会被塞进 Copilot 的头', () => {
  const provider = normalizeProvider('x', { type: 'openai', baseUrl: 'https://x.example' });
  const headers = providerHeaders(provider);
  assert.equal(headers['copilot-integration-id'], undefined);
});

// ---------------------------------------------------------------- baseUrl 解析

test('baseUrl 拆成连接信息', () => {
  const conn = parseProviderBaseUrl('https://api.openai.com/v1');
  assert.equal(conn.protocol, 'https');
  assert.equal(conn.host, 'api.openai.com');
  assert.equal(conn.port, 443);
  assert.equal(conn.basePath, '/v1');
});

test('带端口的 baseUrl', () => {
  const conn = parseProviderBaseUrl('http://127.0.0.1:8080');
  assert.equal(conn.protocol, 'http');
  assert.equal(conn.port, 8080);
  assert.equal(conn.hostHeader, '127.0.0.1:8080');
});

test('非法 baseUrl 返回 null', () => {
  assert.equal(parseProviderBaseUrl('not a url'), null);
  assert.equal(parseProviderBaseUrl(''), null);
});

// ---------------------------------------------------------------- 摘要

test('provider 摘要不包含凭据值', () => {
  const provider = normalizeProvider('x', {
    type: 'openai',
    baseUrl: 'https://x.example',
    auth: { env: 'MY_KEY' },
  });
  const summary = describeProvider(provider);
  assert.equal(summary.name, 'x');
  assert.equal(summary.credential, 'env:MY_KEY');
  assert.ok(!JSON.stringify(summary).includes('sk-'));
});

test('provider 摘要带出 Copilot 的 token 模式', () => {
  const direct = normalizeProvider('c', { type: 'copilot', baseUrl: 'https://api.githubcopilot.com' });
  assert.equal(describeProvider(direct).tokenMode, 'direct');

  const session = normalizeProvider('c', {
    type: 'copilot',
    baseUrl: 'https://api.githubcopilot.com',
    auth: { tokenMode: 'SESSION' },
  });
  assert.equal(session.auth.tokenMode, 'session');
  assert.equal(describeProvider(session).tokenMode, 'session');

  const custom = normalizeProvider('x', { type: 'custom', baseUrl: 'https://x.example' });
  assert.equal(describeProvider(custom).tokenMode, null, 'tokenMode 只属于 Copilot');
});

test('池的摘要按名字列出', () => {
  const pool = normalizeUpstreams({
    providers: {
      a: { type: 'openai', baseUrl: 'https://a.example', auth: { env: 'K' } },
      b: { type: 'anthropic', baseUrl: 'https://b.example', auth: { env: 'K' } },
    },
  });
  assert.deepEqual(describeUpstreams(pool).map((p) => p.name), ['a', 'b']);
});

test('provider 类型清单是已知的几种', () => {
  assert.deepEqual(PROVIDER_TYPES, ['openai', 'anthropic', 'gemini', 'copilot', 'custom']);
});
