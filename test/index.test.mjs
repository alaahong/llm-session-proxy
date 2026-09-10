import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import defaultExport, * as entry from '../src/index.js';
import { DEFAULT_LANG, getLang, setLang } from '../src/messages.js';

/** 包入口（package.json 的 exports["."]）应当导出的名字。 */
const EXPECTED_EXPORTS = [
  'DEFAULT_CONFIG',
  'Logger',
  'NAME',
  'SessionStore',
  'VERSION',
  'applyBodyInject',
  'buildConfig',
  'buildInjectHeaders',
  'contentFingerprint',
  'createContext',
  'createProxyServer',
  'deepMerge',
  'findExplicitSession',
  'generateId',
  'getLang',
  'loadConfigFile',
  'normalizeLang',
  'normalizeSessionId',
  'parseJsonLoose',
  'parseUpstream',
  'randomBase36',
  'randomHex',
  'renderDeep',
  'renderTemplate',
  'resolveSession',
  'resolveUpstream',
  'rewriteModel',
  'rewritePath',
  'setLang',
  'startProxy',
  'translate',
];

test('公共入口的具名导出全部有值（export 了却没 import 会在这里现形）', () => {
  const missing = EXPECTED_EXPORTS.filter((name) => entry[name] === undefined);
  assert.deepEqual(missing, [], `这些导出没有解析出值: ${missing.join(', ')}`);
});

test('公共入口的默认导出包含核心成员', () => {
  for (const name of ['NAME', 'VERSION', 'startProxy', 'createProxyServer', 'buildConfig', 'SessionStore', 'Logger']) {
    assert.ok(defaultExport[name] !== undefined, `默认导出缺少 ${name}`);
  }
  assert.equal(defaultExport.NAME, entry.NAME);
  assert.equal(defaultExport.VERSION, entry.VERSION);
});

test('i18n 助手可以从公共入口使用', () => {
  const previous = getLang();
  try {
    assert.equal(entry.setLang('zh'), 'zh');
    assert.equal(entry.getLang(), 'zh');
    assert.equal(entry.normalizeLang('zh-CN'), 'zh');
    assert.match(entry.translate('cli.shutdown.done'), /[\p{Script=Han}]/u);
  } finally {
    setLang(previous);
  }
});

test('startProxy 端到端可用，并让输出语言跟随 config.lang', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const previous = getLang();
  let proxy = null;
  try {
    proxy = await entry.startProxy({
      silent: true,
      flags: {
        port: 0,
        host: '127.0.0.1',
        lang: 'zh',
        upstream: { host: `http://127.0.0.1:${upstreamPort}` },
      },
    });

    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/, `startProxy 应当给出可用的 url: ${proxy.url}`);
    assert.equal(getLang(), 'zh', 'startProxy 应当按 config.lang 切换输出语言');

    const response = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"deepseek-flash","messages":[]}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    // 本地状态端点应可用，并带上注入头信息
    const status = await fetch(`${proxy.url}/__llm_session_proxy__/status`);
    const payload = await status.json();
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.inject.headers));
  } finally {
    if (proxy) await proxy.stop();
    setLang(previous);
    assert.equal(getLang(), previous);
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('默认语言仍是英文', () => {
  assert.equal(DEFAULT_LANG, 'en');
  assert.equal(entry.setLang('fr'), 'en');
});
