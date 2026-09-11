import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CONFIG,
  buildConfig,
  configFromEnv,
  deepMerge,
  defaultLogDir,
  loadConfigFile,
  parseJsonLoose,
  parseUpstream,
  resolveLogFile,
  resolveUpstream,
  shouldReplaceUserAgent,
} from '../src/config.js';

function writeTempConfig(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('deepMerge 逐层合并普通对象，数组整体覆盖', () => {
  const merged = deepMerge(
    { a: { x: 1, y: 2 }, list: [1, 2], keep: 'v' },
    { a: { y: 9 }, list: [3] },
  );
  assert.deepEqual(merged, { a: { x: 1, y: 9 }, list: [3], keep: 'v' });
});

test('deepMerge 忽略 undefined 且不修改原对象', () => {
  const base = { a: { x: 1 } };
  const merged = deepMerge(base, { a: { x: undefined, y: 2 } });

  assert.deepEqual(merged, { a: { x: 1, y: 2 } });
  assert.deepEqual(base, { a: { x: 1 } }, '原对象不应被改动');
});

test('parseJsonLoose 允许注释与尾随逗号，但不误伤字符串里的 //', () => {
  const parsed = parseJsonLoose(`{
    // 行注释
    "a": 1, /* 块注释 */
    "url": "https://example.com//weird//path",
    "list": [1, 2,],
  }`);

  assert.equal(parsed.a, 1);
  assert.equal(parsed.url, 'https://example.com//weird//path');
  assert.deepEqual(parsed.list, [1, 2]);
});

test('parseJsonLoose 去掉 BOM，且解析失败时带上来源信息', () => {
  assert.deepEqual(parseJsonLoose('\uFEFF{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonLoose('{ oops }', 'demo.json'), /demo\.json/);
});

test('loadConfigFile 读取文件，根节点不是对象时报错', () => {
  const ok = writeTempConfig('{"listen":{"port":1234}}');
  const loaded = loadConfigFile(ok);
  assert.equal(loaded.config.listen.port, 1234);
  assert.equal(loaded.path, ok);

  const bad = writeTempConfig('[1,2,3]');
  assert.throws(() => loadConfigFile(bad), /root must be an object/);
});

test('四级优先级：默认值 < 配置文件 < 环境变量 < 命令行', () => {
  const file = writeTempConfig(
    JSON.stringify({
      listen: { port: 6001 },
      upstream: { host: 'from-file.example' },
      userAgent: 'from-file/1.0',
    }),
  );

  const config = buildConfig({
    file,
    env: { PROXY_PORT: '6002', UPSTREAM_HOST: 'from-env.example' },
    flags: { listen: { port: 6003 } },
  });

  assert.equal(config.listen.port, 6003, '命令行优先级最高');
  assert.equal(config.upstream.host, 'from-env.example', '环境变量高于配置文件');
  assert.equal(config.userAgent, 'from-file/1.0', '配置文件高于默认值');
  assert.equal(config.userAgentMode, DEFAULT_CONFIG.userAgentMode, '未覆盖字段保留默认值');
  assert.equal(config.__configPath, file, '应当记录配置文件来源');
});

test('buildConfig 在不给任何输入时等于默认配置', () => {
  const config = buildConfig({ env: {} });
  assert.equal(config.listen.port, DEFAULT_CONFIG.listen.port);
  assert.equal(config.upstream.host, DEFAULT_CONFIG.upstream.host);
  assert.equal(config.__configPath, null);
  assert.equal(
    Object.keys(config.inject.headers).length,
    Object.keys(DEFAULT_CONFIG.inject.headers).length,
  );
});

test('buildConfig 对非法端口 / 协议 / ID 格式 / 头配置抛错', () => {
  assert.throws(() => buildConfig({ env: {}, flags: { listen: { port: 99999 } } }), /listen\.port/);
  assert.throws(() => buildConfig({ env: {}, flags: { listen: { port: 1.5 } } }), /listen\.port/);
  assert.throws(() => buildConfig({ env: {}, flags: { upstream: { protocol: 'ftp' } } }), /upstream\.protocol/);
  assert.throws(
    () => buildConfig({ env: {}, flags: { session: { idFormat: 'nanoid' } } }),
    /session\.idFormat/,
  );
  assert.throws(
    () => buildConfig({ env: {}, flags: { inject: { headers: ['x-a'] } } }),
    /inject\.headers/,
  );
});

test('upstream.host 写成完整 URL 时自动拆解协议、端口与路径前缀', () => {
  const config = buildConfig({ env: {}, flags: { upstream: { host: 'http://127.0.0.1:8443/v1' } } });

  assert.equal(config.upstream.protocol, 'http');
  assert.equal(config.upstream.host, '127.0.0.1');
  assert.equal(config.upstream.port, 8443);
  assert.equal(config.upstream.basePath, '/v1');
});

test('pathRewrite 支持 from/to 别名，非法正则启动即报错', () => {
  const config = buildConfig({
    env: {},
    flags: { request: { pathRewrite: [{ from: '^/v1/', to: '/zen/go/v1/' }] } },
  });
  assert.deepEqual(config.request.pathRewrite, [
    { pattern: '^/v1/', replacement: '/zen/go/v1/', flags: undefined },
  ]);

  assert.throws(
    () =>
      buildConfig({
        env: {},
        flags: { request: { pathRewrite: [{ pattern: '([', replacement: '' }] } },
      }),
    /Invalid regular expression in pathRewrite/,
  );
});

test('model.stripPrefixes 会过滤掉空串等无效项', () => {
  const config = buildConfig({
    env: {},
    flags: { model: { stripPrefixes: ['proxy-', '', null, 'alt-'] } },
  });
  assert.deepEqual(config.model.stripPrefixes, ['proxy-', 'alt-']);
});

test('configFromEnv 按字段类型做强制转换', () => {
  const fromEnv = configFromEnv({
    PROXY_PORT: '7000',
    MAX_SESSIONS: '64',
    SESSION_TTL: '120',
    MODEL_ALIAS_PREFIX: 'proxy-, alt-',
    INJECT_HEADERS: '{"x-a":"{{session.id}}"}',
    SESSION_ID_FORMAT: 'uuid',
    USER_AGENT_MODE: 'keep',
  });

  assert.equal(fromEnv.listen.port, 7000);
  assert.equal(fromEnv.session.maxSessions, 64);
  assert.equal(fromEnv.session.ttlSeconds, 120);
  assert.deepEqual(fromEnv.model.stripPrefixes, ['proxy-', 'alt-']);
  assert.deepEqual(fromEnv.inject.headers, { 'x-a': '{{session.id}}' });
  assert.equal(fromEnv.session.idFormat, 'uuid');
  assert.equal(fromEnv.userAgentMode, 'keep');
});

test('configFromEnv 忽略空值，数字字段收到非数字时报错', () => {
  assert.deepEqual(configFromEnv({ PROXY_PORT: '', UPSTREAM_HOST: undefined }), {});
  assert.throws(() => configFromEnv({ PROXY_PORT: 'abc' }), /must be a number/);
});

test('resolveUpstream 补全默认端口并组装 Host 头', () => {
  const https = resolveUpstream({
    upstream: { protocol: 'https', host: 'opencode.ai', port: null, basePath: '' },
  });
  assert.equal(https.port, 443);
  assert.equal(https.hostHeader, 'opencode.ai');

  const custom = resolveUpstream({
    upstream: { protocol: 'http', host: '127.0.0.1', port: 11434, basePath: '/v1' },
  });
  assert.equal(custom.port, 11434);
  assert.equal(custom.hostHeader, '127.0.0.1:11434');
  assert.equal(custom.basePath, '/v1');
});

test('shouldReplaceUserAgent 三种模式行为符合预期', () => {
  assert.equal(shouldReplaceUserAgent('node', { userAgentMode: 'keep' }), false);
  assert.equal(shouldReplaceUserAgent('node', { userAgentMode: 'replace' }), true);

  const generic = { userAgentMode: 'replace-generic' };
  assert.equal(shouldReplaceUserAgent('node', generic), true);
  assert.equal(shouldReplaceUserAgent('undici', generic), true);
  assert.equal(shouldReplaceUserAgent('python-requests/2.31.0', generic), true);
  assert.equal(shouldReplaceUserAgent('opencode/1.18.29 cli', generic), true);
  assert.equal(shouldReplaceUserAgent(undefined, generic), true);
  assert.equal(
    shouldReplaceUserAgent('my-coding-agent/1.0', generic),
    false,
    '自家 Agent 的 UA 不应被替换',
  );
});

test('parseUpstream 默认补 https，并把路径当 basePath', () => {
  assert.deepEqual(parseUpstream('opencode.ai'), {
    protocol: 'https',
    host: 'opencode.ai',
    port: null,
    basePath: '',
  });
  assert.deepEqual(parseUpstream('api.example.com:8443/'), {
    protocol: 'https',
    host: 'api.example.com',
    port: 8443,
    basePath: '',
  });
  assert.equal(parseUpstream('').host, undefined);
});

// ------------------------------------------------------------- 日志落盘与轮转

test('默认日志目录：~/.lsp/logs，可用 LSP_HOME 覆盖', () => {
  const fallback = defaultLogDir({});
  assert.equal(path.basename(fallback), 'logs');
  assert.equal(path.basename(path.dirname(fallback)), '.lsp');

  const custom = defaultLogDir({ LSP_HOME: path.join(os.tmpdir(), 'my-home') });
  assert.equal(custom, path.join(os.tmpdir(), 'my-home', 'logs'));
  assert.equal(defaultLogDir({ LSP_HOME: '   ' }), fallback, '空值应当退回默认位置');
});

test('resolveLogFile：默认位置 / 自定义目录 / 指定文件 / 关闭', () => {
  const home = path.join(os.tmpdir(), 'lsp-resolve');

  assert.equal(
    resolveLogFile({}, { env: { LSP_HOME: home }, name: 'demo' }),
    path.join(home, 'logs', 'demo.log'),
  );
  // 只改目录，文件名保持默认
  assert.equal(
    resolveLogFile({ dir: path.join(home, 'other') }, { env: {}, name: 'demo' }),
    path.resolve(path.join(home, 'other'), 'demo.log'),
  );
  // 显式文件优先于目录
  assert.equal(
    resolveLogFile({ file: './custom.log', dir: '/ignored' }, { env: {}, name: 'demo' }),
    path.resolve('./custom.log'),
  );
  // file 为空串等于没写，仍走默认位置
  assert.equal(
    resolveLogFile({ file: '  ' }, { env: { LSP_HOME: home }, name: 'demo' }),
    path.join(home, 'logs', 'demo.log'),
  );
  // 明确关闭
  assert.equal(resolveLogFile({ file: false }, { env: { LSP_HOME: home }, name: 'demo' }), null);
  assert.equal(resolveLogFile({ file: 'x.log' }).endsWith(path.join('x.log')), true, '默认 env 也应当可用');
});

test('日志配置的默认值齐备（默认就会落盘）', () => {
  const config = buildConfig({ env: {} });
  assert.equal(config.log.file, null, '默认 file 为 null 表示走默认位置，而不是不写');
  assert.equal(config.log.dir, null);
  assert.equal(config.log.rotate, 'size');
  assert.equal(config.log.keepDays, 30);
  assert.equal(config.log.maxBytes, DEFAULT_CONFIG.log.maxBytes);
  assert.equal(config.log.backups, DEFAULT_CONFIG.log.backups);
});

test('日志配置可从环境变量覆盖', () => {
  const fromEnv = configFromEnv({
    LOG_DIR: '/tmp/mylogs',
    LOG_ROTATE: 'DAILY',
    LOG_KEEP_DAYS: '7',
    LOG_MAX_BYTES: '2048',
    LOG_BACKUPS: '5',
    LOG_LEVEL: 'debug',
  });

  assert.equal(fromEnv.log.dir, '/tmp/mylogs');
  assert.equal(fromEnv.log.rotate, 'daily', '应当归一化成小写');
  assert.equal(fromEnv.log.keepDays, 7);
  assert.equal(fromEnv.log.maxBytes, 2048);
  assert.equal(fromEnv.log.backups, 5);
  assert.equal(fromEnv.log.level, 'debug');

  // LOG_FILE=off 关闭文件输出
  assert.equal(configFromEnv({ LOG_FILE: 'off' }).log.file, false);
  assert.equal(configFromEnv({ LOG_FILE: 'none' }).log.file, false);
  assert.equal(configFromEnv({ LOG_FILE: './a.log' }).log.file, './a.log');
});

test('非法日志配置在启动时就报错，而不是静默退化成不写日志', () => {
  assert.throws(
    () => buildConfig({ env: {}, flags: { log: { rotate: 'weekly' } } }),
    /log\.rotate/,
  );
  assert.throws(() => buildConfig({ env: {}, flags: { log: { level: 'verbose' } } }), /log\.level/);
  assert.throws(() => buildConfig({ env: {}, flags: { log: { keepDays: -1 } } }), /log\.keepDays/);
  assert.throws(() => buildConfig({ env: {}, flags: { log: { file: 42 } } }), /log\.file/);
  assert.throws(() => buildConfig({ env: {}, flags: { log: { dir: 42 } } }), /log\.dir/);
  assert.throws(() => buildConfig({ env: {}, flags: { log: null } }), /log must be an object/);
});

test('日志配置的字符串空值会被归一化成默认值', () => {
  const config = buildConfig({ env: {}, flags: { log: { file: '   ', dir: '', rotate: ' DAILY ' } } });
  assert.equal(config.log.file, null);
  assert.equal(config.log.dir, null);
  assert.equal(config.log.rotate, 'daily');
});
