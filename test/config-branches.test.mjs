import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConfig, configFromEnv, deepMerge, resolveUpstream, shouldReplaceUserAgent } from '../src/config.js';

/**
 * 配置校验的分支覆盖。
 *
 * config.test.mjs 覆盖的是「配置写对了怎么生效」，这里补的是**配置写错时的表现**：
 * 难度打分与档位、协议互转、上游池这三段平时很少有人配，配错了也最难自己发现——
 * 代理照样启动、照样转发，只是每个请求都发到不该去的地方。
 *
 * 判据统一：**配置写错必须在启动时就说清楚**——类型不对、名字拼错、
 * 指向不存在的桶/档位/上游，一律启动即报错；绝不静默退回默认值。
 * 静默退回 = 「配了但没生效」，和报错是同一种坑，只是更隐蔽。
 */

/** 按命令行参数的形状构造配置（顶层覆盖必须走 flags）。 */
function build(flags) {
  return buildConfig({ env: {}, flags });
}

/** 断言「启动即报错」，并把报错内容带出来方便排查。 */
function assertRejects(flags, pattern) {
  assert.throws(() => build(flags), pattern);
}

// ---------------------------------------------------------------- 难度打分与档位

test('router.scorers.enabled 不是数组时启动即报错', () => {
  assertRejects({ router: { scorers: { enabled: 'builtin-complexity' } } }, /router\.scorers\.enabled/);
});

test('打分器名字拼错时启动即报错，并把可用名字列出来', () => {
  assertRejects(
    { router: { scorers: { enabled: ['builtin-complexityy'] } } },
    /not a registered scorer.*builtin-complexity/,
  );
});

test('档位重名时启动即报错', () => {
  assertRejects(
    {
      router: {
        bands: [
          { name: 'easy', maxScore: 30 },
          { name: 'easy', maxScore: 60 },
        ],
      },
    },
    /duplicate band name "easy"/,
  );
});

test('档位分数越界时启动即报错', () => {
  assertRejects({ router: { bands: [{ name: 'easy', maxScore: 150 }] } }, /maxScore must be a number between 0 and 100/);
  assertRejects({ router: { bands: [{ name: 'easy', maxScore: -1 }] } }, /maxScore must be a number between 0 and 100/);
});

test('档位分数不是数字时启动即报错，而不是悄悄当成 0', () => {
  assertRejects({ router: { bands: [{ name: 'easy', maxScore: 'high' }] } }, /maxScore must be a number between 0 and 100/);
});

test('规则的 difficulty 指向不存在的档位时启动即报错', () => {
  assertRejects(
    {
      router: {
        enabled: true,
        rules: [{ bucket: 'default', difficulty: 'ghost' }],
      },
    },
    /difficulty must be a declared band/,
  );
});

test('规则的字节数条件非法时启动即报错', () => {
  assertRejects(
    { router: { enabled: true, rules: [{ bucket: 'default', maxBytes: -1 }] } },
    /maxBytes must be a non-negative number/,
  );
});

test('打分器与档位配对了就不该报错', () => {
  const config = build({
    router: {
      enabled: true,
      scorers: { enabled: ['builtin-complexity'], options: { 'builtin-complexity': { weights: { bytes: 10 } } } },
      bands: [
        { name: 'easy', maxScore: 30 },
        { name: 'hard', maxScore: 100 },
      ],
      rules: [{ bucket: 'default', difficulty: 'easy' }],
    },
  });

  assert.deepEqual(config.router.scorers.enabled, ['builtin-complexity']);
  assert.equal(config.router.bands.length, 2);
});

// ---------------------------------------------------------------- 协议互转

test('protocol 段写错时启动即报错', () => {
  assertRejects({ protocol: null }, /protocol must be an object/);
  assertRejects({ protocol: { enabled: 'yes' } }, /protocol\.enabled must be a boolean/);
  assertRejects({ protocol: { forced: 'grpc' } }, /--protocol "grpc" is not a known protocol/);
});

test('protocol 的路径不以 / 开头时启动即报错', () => {
  assertRejects({ protocol: { paths: { chat: 'chat/completions' } } }, /protocol\.paths\.chat must be a path starting with/);
  assertRejects({ protocol: { paths: { chat: 123 } } }, /protocol\.paths\.chat must be a path starting with/);
});

test('protocol 的路由写错时启动即报错', () => {
  assertRejects({ protocol: { routes: [{ target: 'grpc' }] } }, /protocol\.routes\[0\]\.target must be one of/);
  assertRejects({ protocol: { routes: [{ target: 'chat', model: '' }] } }, /protocol\.routes\[0\]\.model must be a non-empty/);
  assertRejects({ protocol: { routes: [{ target: 'chat', path: 'chat/x' }] } }, /protocol\.routes\[0\]\.path must be a path starting with/);
});

test('protocol 的路由解析不出上游路径时启动即报错', () => {
  assertRejects(
    { protocol: { paths: { chat: 'chat/completions' }, routes: [{ target: 'chat' }] } },
    /protocol\.routes\[0\].*resolves to no upstream path/,
  );
});

test('protocol 配对了就不该报错', () => {
  const config = build({
    protocol: {
      enabled: true,
      forced: 'messages',
      routes: [{ target: 'responses', model: 'proxy-gpt-5', path: '/v1/responses' }],
    },
  });

  assert.equal(config.protocol.enabled, true);
  assert.equal(config.protocol.forced, 'messages');
  assert.equal(config.protocol.routes.length, 1);
});

// ---------------------------------------------------------------- 上游池

test('upstreams 段写错时启动即报错', () => {
  assertRejects({ upstreams: null }, /upstreams must be an object/);
});

test('provider 不是对象时启动即报错', () => {
  assertRejects({ upstreams: { providers: { a: 'not-an-object' } } }, /upstreams\.providers\["a"\] must be an object/);
});

test('provider 的 type 不是已知类型时启动即报错', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434' } } } },
    /upstreams\.providers\["a"\]\.type must be one of/,
  );
});

test('provider 的 type 写成原型上的键时也是清晰报错，不是崩在奇怪的地方', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: '__proto__', baseUrl: 'https://a.example' } } } },
    /upstreams\.providers\["a"\]\.type must be one of/,
  );
});

test('provider 缺 baseUrl 时启动即报错', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai' } } } },
    /upstreams\.providers\["a"\]\.baseUrl is required/,
  );
});

test('provider 的 baseUrl 不是 http(s) 时启动即报错，并把实际值写进消息', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai', baseUrl: 'ftp://example.com' } } } },
    /must start with http:\/\/ or https:\/\/.*ftp:\/\/example\.com/,
  );
});

test('provider 的端点路径不以 / 开头时启动即报错', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai', baseUrl: 'https://a.example', paths: { chat: 'chat/x' } } } } },
    /upstreams\.providers\["a"\]\.paths\["chat"\] must be a path starting with/,
  );
});

test('provider 的 wire 不是已知协议时启动即报错', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai', baseUrl: 'https://a.example', wire: ['grpc'] } } } },
    /upstreams\.providers\["a"\]\.wire must be one of/,
  );
});

test('provider 的 auth 不是对象时启动即报错，而不是当成「没有凭据」', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai', baseUrl: 'https://a.example', auth: 'MY_TOKEN' } } } },
    /upstreams\.providers\["a"\]\.auth must be an object/,
  );
});

test('provider 的 auth 没说明凭据从哪来时启动即报错', () => {
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai', baseUrl: 'https://a.example', auth: {} } } } },
    /upstreams\.providers\["a"\]\.auth must declare where the credential comes from/,
  );
  assertRejects(
    { upstreams: { providers: { a: { type: 'openai', baseUrl: 'https://a.example', auth: { env: '   ' } } } } },
    /must declare where the credential comes from/,
  );
});

test('Copilot provider 可以不写 auth —— 凭据走内置 GitHub token 链', () => {
  const config = build({
    upstreams: {
      providers: { c: { type: 'copilot', baseUrl: 'https://api.githubcopilot.com' } },
    },
  });
  assert.equal(config.upstreams.providers.c.type, 'copilot');
  assert.equal(config.upstreams.providers.c.auth, null);
});

test('Copilot provider 的 tokenMode 只认 direct / session', () => {
  const direct = build({
    upstreams: {
      providers: {
        c: { type: 'copilot', baseUrl: 'https://api.githubcopilot.com', auth: { tokenMode: 'DIRECT' } },
      },
    },
  });
  assert.equal(direct.upstreams.providers.c.auth.tokenMode, 'direct');

  const session = build({
    upstreams: {
      providers: {
        c: { type: 'copilot', baseUrl: 'https://api.githubcopilot.com', auth: { tokenMode: 'session' } },
      },
    },
  });
  assert.equal(session.upstreams.providers.c.auth.tokenMode, 'session');

  assertRejects(
    {
      upstreams: {
        providers: {
          c: { type: 'copilot', baseUrl: 'https://api.githubcopilot.com', auth: { tokenMode: 'exchange' } },
        },
      },
    },
    /auth\.tokenMode must be one of direct \| session, got "exchange"/,
  );
  assertRejects(
    {
      upstreams: {
        providers: {
          c: { type: 'copilot', baseUrl: 'https://api.githubcopilot.com', auth: { tokenMode: 123 } },
        },
      },
    },
    /auth\.tokenMode must be one of direct \| session, got 123/,
  );
});

test('非 Copilot provider 写 tokenMode 时启动即报错', () => {
  assertRejects(
    {
      upstreams: {
        providers: {
          a: { type: 'openai', baseUrl: 'https://a.example', auth: { env: 'K', tokenMode: 'direct' } },
        },
      },
    },
    /auth\.tokenMode is only valid for type "copilot"/,
  );
});

test('上游路由没指向上游时启动即报错', () => {
  assertRejects(
    {
      upstreams: {
        providers: { a: { type: 'openai', baseUrl: 'https://a.example' } },
        routes: [{ model: 'gpt-5' }],
      },
    },
    /upstreams\.routes\[0\] points at upstream/,
  );
});

test('上游池的 default 指向不存在的 provider 时启动即报错', () => {
  assertRejects(
    {
      upstreams: {
        providers: { a: { type: 'openai', baseUrl: 'https://a.example' } },
        default: 'ghost',
      },
    },
    /upstreams\.default "ghost" is not declared/,
  );
});

test('上游池配对了就不该报错', () => {
  const config = build({
    upstreams: {
      enabled: true,
      providers: {
        a: { type: 'openai', baseUrl: 'https://a.example', auth: { env: 'A_KEY' } },
        b: { type: 'anthropic', baseUrl: 'https://b.example', auth: { command: 'op read op://vault/key' } },
      },
      routes: [{ model: 'gpt-5', upstream: 'a' }],
      default: 'b',
    },
  });

  assert.equal(Object.keys(config.upstreams.providers).length, 2);
  assert.equal(config.upstreams.default, 'b');
});

test('空的上游池不报错（空池 = 走旧 upstream）', () => {
  const config = build({ upstreams: { enabled: true, providers: {}, routes: [], default: null } });
  assert.deepEqual(config.upstreams.providers, {});
});

test('没有凭据的本地端点是允许的', () => {
  const config = build({
    upstreams: { providers: { local: { type: 'custom', baseUrl: 'http://127.0.0.1:11434' } } },
  });
  assert.equal(config.upstreams.providers.local.auth, null);
});

// ---------------------------------------------------------------- 环境变量

test('环境变量里的布尔与数字字段照常强转', () => {
  const fromEnv = configFromEnv({
    PROTOCOL_ENABLED: 'true',
    PATH_REWRITE: '[{"pattern":"^/v1/","replacement":"/zen/go/v1/"}]',
    TRANSFORMERS: 'noop, drop-fields',
    MODEL_ALIAS_PREFIX: 'proxy-',
    UPSTREAM_BASE_PATH: '/zen/go',
    OPENCODE_UA: 'opencode/1.0 cli',
    USER_AGENT: 'my-agent/1.0',
    SESSION_ID_PREFIX: 'k_',
    REQUEST_ID_FORMAT: 'req_{{session.count}}',
    TIMEOUT_MS: '1234',
    MAX_BODY_BYTES: '2048',
    PROXY_LANG: 'zh',
  });

  assert.equal(fromEnv.protocol.enabled, true);
  assert.deepEqual(fromEnv.request.pathRewrite, [{ pattern: '^/v1/', replacement: '/zen/go/v1/' }]);
  assert.deepEqual(fromEnv.transformers.enabled, ['noop', 'drop-fields']);
  assert.deepEqual(fromEnv.model.stripPrefixes, ['proxy-']);
  assert.equal(fromEnv.upstream.basePath, '/zen/go');
  assert.equal(fromEnv.userAgent, 'my-agent/1.0');
  assert.equal(fromEnv.session.idPrefix, 'k_');
  assert.equal(fromEnv.session.requestIdFormat, 'req_{{session.count}}');
  assert.equal(fromEnv.request.timeoutMs, 1234);
  assert.equal(fromEnv.request.maxBodyBytes, 2048);
  assert.equal(fromEnv.lang, 'zh');
});

test('LOG_FILE 的各种「关掉」写法都认', () => {
  for (const raw of ['off', 'none', 'false', 'no', '0', 'OFF']) {
    assert.equal(configFromEnv({ LOG_FILE: raw }).log.file, false, `LOG_FILE=${raw} 应当关闭文件输出`);
  }
  assert.equal(configFromEnv({ LOG_FILE: './a.log' }).log.file, './a.log');
});

test('布尔环境变量的各种写法都认', () => {
  assert.equal(configFromEnv({ ROUTER_ENABLED: 'on' }).router.enabled, true);
  assert.equal(configFromEnv({ ROUTER_ENABLED: '0' }).router.enabled, false);
  assert.equal(configFromEnv({ ROUTER_ENABLED: 'disabled' }).router.enabled, false);
  assert.equal(configFromEnv({ PROTOCOL_ENABLED: 'no' }).protocol.enabled, false);
  assert.equal(configFromEnv({ PROTOCOL_ENABLED: 'yes' }).protocol.enabled, true);
});

test('环境变量里的 JSON 写错时报错，而不是默默忽略', () => {
  assert.throws(() => configFromEnv({ PATH_REWRITE: '{oops' }), SyntaxError);
  assert.throws(() => configFromEnv({ INJECT_HEADERS: 'not json' }), SyntaxError);
});

// ---------------------------------------------------------------- 归一化的边缘形态

test('deepMerge 遇到非对象的覆盖值时直接用它，数组底也照样合并', () => {
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 }, 'undefined 覆盖等于没写');
  assert.equal(deepMerge({ a: 1 }, 'raw'), 'raw');
  assert.deepEqual(deepMerge([1, 2], { 0: 9 }), [9, 2], '底是数组时先摊开再逐键覆盖');
  assert.deepEqual(deepMerge('not-an-object', { a: 1 }), { a: 1 }, '底不是对象时从空对象开始');
});

test('CONFIG_FILE 环境变量被单独记下来，交给 buildConfig 用', () => {
  assert.equal(configFromEnv({ CONFIG_FILE: '/tmp/demo.json' }).__configFile, '/tmp/demo.json');
});

test('pathRewrite 里写坏了的规则被丢掉，而不是带着半截内容去转发', () => {
  const config = build({
    request: {
      pathRewrite: [
        '不是对象',
        { pattern: '^/v1/' },
        { from: 123 },
        { pattern: '^/v2/', replacement: '/x/' },
      ],
    },
  });

  assert.deepEqual(config.request.pathRewrite, [
    { pattern: '^/v1/', replacement: '', flags: undefined },
    { pattern: '^/v2/', replacement: '/x/', flags: undefined },
  ]);
});

test('router 的桶写坏了时要么报错要么退成空桶，不留半截配置', () => {
  // buckets 整个写成了字符串：桶列表为空，启动即报错
  assertRejects({ router: { buckets: 'not-an-object' } }, /router\.buckets must declare at least one bucket/);

  const config = build({
    router: {
      buckets: {
        broken: 'not-an-object',
        think: { transformers: 'not-an-array', upstream: '  ' },
        plan: { upstream: 'provider-a' },
      },
    },
  });

  assert.equal(config.router.buckets.broken, undefined, '不是对象的桶直接丢掉');
  assert.deepEqual(config.router.buckets.think.transformers, [], 'transformers 不是数组就当没有');
  assert.equal(config.router.buckets.think.upstream, null, '空白的上游名当没有');
  assert.equal(config.router.buckets.plan.upstream, 'provider-a', '正常上游名要留住');
});

test('router 的段写成了别的类型时不当成「没配」', () => {
  // scorers 整个写成了字符串：启动即报错
  assertRejects({ router: { scorers: 'not-an-object' } }, /router\.scorers\.enabled/);

  // options 不是对象：这一条目前没有专门的文案，退回空对象（见最终报告）
  const config = build({ router: { scorers: { options: [] } } });
  assert.deepEqual(config.router.scorers.options, {});

  // bands / rules 不是数组：按「没配」处理，档位退回默认
  const noBands = build({ router: { bands: 'not-an-array', rules: 'not-an-array' } });
  assert.deepEqual(noBands.router.bands, []);
  assert.deepEqual(noBands.router.rules, []);
});

test('protocol 的路由写坏了时按原样保留给校验去报', () => {
  assertRejects({ protocol: { routes: ['not-an-object'] } }, /protocol\.routes\[0\]\.target/);
  assertRejects({ protocol: { paths: null, routes: [{ target: 'chat' }] } }, /protocol\.paths\.chat/);

  const config = build({ protocol: { routes: [{ target: 'chat', path: '   ' }] } });
  assert.equal(config.protocol.routes[0].path, undefined, '空白的路径直接删掉，交给 paths 兜底');
});

test('上游池的 providers 不是对象时启动即报错', () => {
  assertRejects({ upstreams: { providers: 'not-an-object' } }, /upstreams must be an object/);
});

test('上游、协议与语言写错时启动即报错', () => {
  assertRejects({ upstream: { host: '' } }, /upstream\.host cannot be empty/);
  assertRejects({ lang: 'xx' }, /Unsupported lang/);
});

test('日志的文件与目录写成正常路径时不报错', () => {
  const config = build({ log: { file: '/tmp/demo.log', dir: '/tmp/logs' } });
  assert.equal(config.log.file, '/tmp/demo.log');
  assert.equal(config.log.dir, '/tmp/logs');
});

test('userAgentMode 写成空串时按默认的 replace-generic 处理', () => {
  const config = build({ userAgentMode: '' });
  assert.equal(config.userAgentMode, '');
  assert.equal(resolveUpstream(config).hostHeader, 'opencode.ai');
  assert.equal(shouldReplaceUserAgent('node', { userAgentMode: '' }), true, '空串按默认模式处理');
});
