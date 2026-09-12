import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, buildConfig } from '../src/config.js';
import { converterName, detectProtocol, describeProtocolRoute, resolveProtocolRoute, upstreamPathFor } from '../src/protocol.js';

test('detectProtocol 从路径识别三种协议', () => {
  assert.equal(detectProtocol('/v1/chat/completions'), 'chat');
  assert.equal(detectProtocol('/zen/go/v1/chat/completions'), 'chat');
  assert.equal(detectProtocol('/v1/messages'), 'messages');
  assert.equal(detectProtocol('/v1/responses'), 'responses');
  assert.equal(detectProtocol('/api/anthropic/v1/messages'), 'messages');
});

test('detectProtocol 认不出的路径返回 null（按既有行为原样转发）', () => {
  assert.equal(detectProtocol('/v1/embeddings'), null);
  assert.equal(detectProtocol('/'), null);
  assert.equal(detectProtocol(''), null);
  assert.equal(detectProtocol(null), null);
  assert.equal(detectProtocol(undefined), null);
});

test('converterName 只对「不同协议的组合」给出方向敏感的名字', () => {
  assert.equal(converterName('chat', 'messages'), 'chat->messages');
  assert.equal(converterName('messages', 'chat'), 'messages->chat');
  assert.equal(converterName('chat', 'chat'), null);
  assert.equal(converterName('chat', 'nope'), null);
  assert.equal(converterName('nope', 'chat'), null);
});

test('resolveProtocolRoute：forced 优先于一切，包括 enabled=false', () => {
  const hit = resolveProtocolRoute({ clientModel: 'gpt-4o' }, { enabled: false, forced: 'messages' });
  assert.deepEqual(hit, { target: 'messages', source: 'forced', index: null });

  // enabled 默认 false（DEFAULT_CONFIG）时，没有 forced 就不转
  const off = resolveProtocolRoute({ clientModel: 'gpt-4o' }, { enabled: false, forced: null });
  assert.deepEqual(off, { target: null, source: 'none', index: null });
});

test('resolveProtocolRoute：路由自上而下，首个命中生效', () => {
  const config = {
    enabled: true,
    forced: null,
    routes: [
      { model: 'minimax', target: 'messages' },
      { model: 'gpt', target: 'responses' },
    ],
  };
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'minimax-m2' }, config), {
    target: 'messages',
    source: 'rule',
    index: 0,
  });
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'gpt-4o' }, config), {
    target: 'responses',
    source: 'rule',
    index: 1,
  });
});

test('resolveProtocolRoute：model 前缀同时匹配客户端原始名与解析后的名字', () => {
  const config = { enabled: true, forced: null, routes: [{ model: 'proxy-think', target: 'messages' }] };
  assert.equal(resolveProtocolRoute({ clientModel: 'proxy-think-x', resolvedModel: 'glm-5.3' }, config).target, 'messages');
  assert.equal(resolveProtocolRoute({ clientModel: 'other', resolvedModel: 'proxy-think-glm' }, config).target, 'messages');
  assert.equal(resolveProtocolRoute({ clientModel: 'other', resolvedModel: 'glm-5.3' }, config).target, null);
});

test('resolveProtocolRoute：不带 model 的路由匹配一切请求', () => {
  const config = { enabled: true, forced: null, routes: [{ target: 'responses' }] };
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'anything' }, config), {
    target: 'responses',
    source: 'rule',
    index: 0,
  });
  // 整库只有一个上游协议时就是这么用的：连模型名都没有也命中
  assert.deepEqual(resolveProtocolRoute({}, config).target, 'responses');
});

test('resolveProtocolRoute：没有路由或全都不命中时返回 none', () => {
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'x' }, { enabled: true, routes: [] }).source, 'none');
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'x' }, {}).source, 'none');
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'x' }, null).source, 'none');
  // 残缺的规则被跳过，而不是抛错
  const config = { enabled: true, routes: [null, {}, { model: 'ok', target: 'messages' }] };
  assert.deepEqual(resolveProtocolRoute({ clientModel: 'ok-1' }, config).index, 2);
});

test('describeProtocolRoute 输出人能读的匹配式', () => {
  assert.equal(describeProtocolRoute({ model: 'minimax', target: 'messages' }), 'model~=minimax* -> messages');
  assert.equal(describeProtocolRoute({ target: 'responses' }), 'model~=* -> responses');
});

test('upstreamPathFor：route.path 显式指定时优先，否则查 paths 表', () => {
  const config = { paths: { chat: '/up/chat', messages: '/up/messages' } };
  assert.equal(upstreamPathFor('messages', config), '/up/messages');
  assert.equal(upstreamPathFor('messages', config, '/explicit/path'), '/explicit/path');
  assert.equal(upstreamPathFor('responses', config), null);
  assert.equal(upstreamPathFor('messages', null, '/only/route'), '/only/route');
});

test('默认配置：protocol 关闭、路径表齐备、路由为空', () => {
  assert.equal(DEFAULT_CONFIG.protocol.enabled, false);
  assert.equal(DEFAULT_CONFIG.protocol.forced, null);
  assert.deepEqual(DEFAULT_CONFIG.protocol.routes, []);
  assert.ok(DEFAULT_CONFIG.protocol.paths.chat.startsWith('/'));
  assert.ok(DEFAULT_CONFIG.protocol.paths.messages.startsWith('/'));
  assert.ok(DEFAULT_CONFIG.protocol.paths.responses.startsWith('/'));
});

test('protocol 段的配置错误都在启动时暴露', () => {
  const cases = [
    [{ protocol: 'not-an-object' }, 'protocol must be an object'],
    [{ protocol: { enabled: 'yes' } }, 'protocol.enabled must be a boolean'],
    [{ protocol: { forced: 'grpc' } }, 'is not a known protocol'],
    [{ protocol: { paths: { chat: 'no-slash' } } }, 'protocol.paths.chat must be a path'],
    [{ protocol: { routes: [{ target: 'ws' }] } }, 'routes[0].target must be one of'],
    [{ protocol: { routes: [{ target: 'chat', model: '' }] } }, 'routes[0].model must be a non-empty'],
    [{ protocol: { routes: [{ target: 'chat', path: 'x' }] } }, 'routes[0].path must be a path'],
  ];
  for (const [overrides, expected] of cases) {
    assert.throws(
      () => buildConfig({ env: {}, flags: overrides }),
      (error) => error.message.includes(expected),
      `期望 ${JSON.stringify(overrides)} 报含 "${expected}" 的错`,
    );
  }
});

test('合法的 protocol 段通过校验并进入配置', () => {
  const config = buildConfig({
    env: {},
    flags: {
      protocol: {
        enabled: true,
        routes: [{ model: 'minimax', target: 'messages', path: '/anthropic/v1/messages' }],
      },
    },
  });
  assert.equal(config.protocol.enabled, true);
  assert.equal(config.protocol.routes.length, 1);
  assert.equal(config.protocol.routes[0].target, 'messages');
});
