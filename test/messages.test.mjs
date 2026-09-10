import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { helpText, printBanner, sampleConfig } from '../src/cli.js';
import { buildConfig, parseJsonLoose } from '../src/config.js';
import { DEFAULT_LANG, MESSAGES, MESSAGE_KEYS, SUPPORTED_LANGS, getLang, normalizeLang, setLang, t } from '../src/messages.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'llm-session-proxy.js');
const runCli = (args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

/** 收集 printBanner 输出的假 logger。 */
const collector = () => {
  const lines = [];
  const push = (...args) => lines.push(args.join(' '));
  return { lines, info: push, warn: push, error: push, debug: push, text: () => lines.join('\n') };
};

test('默认语言是英文', () => {
  assert.equal(DEFAULT_LANG, 'en');
  assert.deepEqual(SUPPORTED_LANGS, ['en', 'zh']);
});

test('两套文案的 key 集合完全一致（防止漏翻译）', () => {
  const enKeys = Object.keys(MESSAGES.en).sort();
  const zhKeys = Object.keys(MESSAGES.zh).sort();
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key));
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key));

  assert.deepEqual(missingInZh, [], `中文文案缺少这些 key: ${missingInZh.join(', ')}`);
  assert.deepEqual(missingInEn, [], `英文文案缺少这些 key: ${missingInEn.join(', ')}`);
  assert.deepEqual(MESSAGE_KEYS.sort(), enKeys);
});

/** 文案渲染用的陪衬参数：覆盖所有会取具名参数的地方，让「逐 key 渲染」不会因为缺参而抛错。 */
const PROBE = {
  name: 'llm-session-proxy',
  version: '0.0.0',
  defaults: { port: 9355, host: '127.0.0.1', timeoutMs: 600000, maxBodyBytes: 1024 },
  source: 'config.json',
  path: '/tmp/config.json',
  key: 'listen.port',
  raw: 'abc',
  pattern: '^/v1/',
  message: 'boom',
  port: 99999,
  protocol: 'ftp',
  format: 'nope',
  lang: 'fr',
  list: 'a, b',
  json: '{}',
  url: 'http://127.0.0.1:9355',
  host: 'localhost',
  target: '/tmp/out.json',
  pathname: '/__llm_session_proxy__/nope',
  timeoutMs: 60000,
  origin: 'https://opencode.ai',
  value: 'v',
  method: 'POST',
  code: 'HPE_INVALID_METHOD',
  detail: 'stack',
  prefix: 'p',
  map: '{}',
  basePath: '/zen/go/v1',
  requestIdFormat: 'msg_{{session.count}}',
  maxBytes: 1024,
  targetPath: '/zen/go/v1/chat/completions',
  kind: 'uncaughtException',
  seconds: 60,
  count: 21,
  nextPort: 9356,
  signal: 'SIGINT',
};

test('两套文案的取值类型一致，且都能渲染出字符串', () => {
  for (const key of MESSAGE_KEYS) {
    assert.equal(typeof MESSAGES.en[key], typeof MESSAGES.zh[key], `key ${key} 的取值类型在两套语言里不一致`);
    for (const lang of SUPPORTED_LANGS) {
      setLang(lang);
      const value = t(key, PROBE);
      assert.equal(typeof value, 'string', `key ${key} 在 ${lang} 下没有渲染成字符串`);
      assert.notEqual(value.length, 0, `key ${key} 在 ${lang} 下渲染为空`);
    }
  }
  setLang(DEFAULT_LANG);
});

test('英文文案里不应混入中文（日志前缀除外，但前缀本身也是 ASCII）', () => {
  setLang('en');
  try {
    for (const key of MESSAGE_KEYS) {
      const value = t(key, PROBE);
      assert.ok(!/\p{Script=Han}/u.test(value), `英文文案 ${key} 里混入了中文: ${value.slice(0, 60)}`);
    }
  } finally {
    setLang(DEFAULT_LANG);
  }
});

test('中文文案的关键条目确实含中文', () => {
  setLang('zh');
  try {
    for (const key of ['cli.help', 'cli.sampleConfig', 'cli.banner.started', 'config.validationFailed']) {
      assert.ok(/\p{Script=Han}/u.test(t(key, PROBE)), `${key} 应当是中文`);
    }
  } finally {
    setLang(DEFAULT_LANG);
  }
});

test('normalizeLang 兼容常见写法，无法识别时返回 null', () => {
  for (const value of ['zh', 'zh-CN', 'zh-Hans', 'zh_CN', 'CN', '中文']) {
    assert.equal(normalizeLang(value), 'zh', `${value} 应识别为 zh`);
  }
  for (const value of ['en', 'en-US', 'EN-us', 'english']) {
    assert.equal(normalizeLang(value), 'en', `${value} 应识别为 en`);
  }
  for (const value of ['fr', 'de-DE', '', '  ', null, undefined, 42]) {
    assert.equal(normalizeLang(value), null, `${String(value)} 不应被识别`);
  }
});

test('t() 遇到未知 key 时原样返回 key，不返回 undefined', () => {
  assert.equal(t('nope.not.a.key'), 'nope.not.a.key');
});

test('setLang 对无法识别的语言退回默认语言', () => {
  assert.equal(setLang('fr'), DEFAULT_LANG);
  assert.equal(getLang(), DEFAULT_LANG);
  assert.equal(setLang(undefined), DEFAULT_LANG);
});

test('lang 参与四层合并：命令行 > 环境变量 > 配置文件 > 默认值', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-lang-')), 'config.json');
  fs.writeFileSync(file, '{"lang":"zh"}', 'utf8');

  assert.equal(buildConfig({ file, env: {}, flags: {} }).lang, 'zh', '配置文件应当生效');
  assert.equal(buildConfig({ file, env: { PROXY_LANG: 'en' }, flags: {} }).lang, 'en', '环境变量应当盖过配置文件');
  assert.equal(buildConfig({ file, env: { PROXY_LANG: 'en' }, flags: { lang: 'zh-CN' } }).lang, 'zh', '命令行应当盖过环境变量');
  assert.equal(buildConfig({ env: {}, flags: {} }).lang, 'en', '没有任何来源时应当是英文');
  setLang(DEFAULT_LANG);
});

test('buildConfig 会把语言应用到当前输出语言', () => {
  const previous = getLang();
  try {
    buildConfig({ env: { PROXY_LANG: 'zh' }, flags: {} });
    assert.equal(getLang(), 'zh', 'buildConfig 应当按合并后的 lang 切换输出语言');
  } finally {
    setLang(previous);
  }
});

test('非法 lang 会被配置校验拦下', () => {
  assert.throws(
    () => buildConfig({ env: {}, flags: { lang: 'fr' } }),
    /Unsupported lang: fr/,
  );
  setLang(DEFAULT_LANG);
});

test('校验报错的语言跟随 --lang：同一个错误在中英文下各出一版', () => {
  const expectEnglish = () => buildConfig({ env: {}, flags: { lang: 'en', listen: { port: 99999 } } });
  const expectChinese = () => buildConfig({ env: {}, flags: { lang: 'zh', listen: { port: 99999 } } });

  try {
    assert.throws(expectEnglish, /Invalid listen\.port/);
    assert.throws(expectChinese, /listen\.port 不合法/);
  } finally {
    setLang(DEFAULT_LANG);
  }
});

test('两种语言的示例配置都能被自己的宽松 JSON 解析', () => {
  for (const lang of SUPPORTED_LANGS) {
    const text = sampleConfig(lang);
    const parsed = parseJsonLoose(text, `sample-${lang}.json`);
    assert.equal(parsed.listen.port, 9355, `${lang} 示例配置应当能解析`);
    assert.equal(parsed.lang, 'en', `${lang} 示例配置里声明的默认语言应当是 en`);
  }
});

test('两种语言的帮助文本都能生成，且都覆盖全部选项', () => {
  for (const lang of SUPPORTED_LANGS) {
    const text = helpText(lang);
    assert.ok(text.includes('llm-session-proxy'), `${lang} 帮助里应当有包名`);
    for (const flag of ['--lang', '--inject', '--init', '--print-config', '--log-file']) {
      assert.ok(text.includes(flag), `${lang} 帮助里应当提到 ${flag}`);
    }
  }
});

test('CLI 端到端：默认英文，--lang zh 出中文，PROXY_LANG 也生效', () => {
  const english = runCli(['--help']);
  assert.ok(english.includes('A configurable local reverse proxy'), '默认应当是英文帮助');

  const chinese = runCli(['--lang', 'zh', '--help']);
  assert.ok(chinese.includes('可自定义参数的 LLM 本地反向代理'), '--lang zh 应当是中文帮助');

  const fromEnv = execFileSync(process.execPath, [bin, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, PROXY_LANG: 'zh' },
  });
  assert.ok(fromEnv.includes('可自定义参数的 LLM 本地反向代理'), 'PROXY_LANG=zh 应当是中文帮助');
});

test('启动横幅按语言输出，且英文横幅里没有中文', () => {
  const config = buildConfig({ env: {}, flags: {} });
  const zhConfig = buildConfig({ env: {}, flags: { lang: 'zh' } });
  const proxy = { upstream: { protocol: 'https', hostHeader: 'opencode.ai', basePath: '' } };
  const url = 'http://127.0.0.1:9355';

  setLang('en');
  const en = collector();
  printBanner(en, config, proxy, url);

  setLang('zh');
  const zh = collector();
  printBanner(zh, zhConfig, proxy, url);

  setLang(DEFAULT_LANG);

  assert.ok(en.text().includes('started'), `英文横幅应当出现 "started":\n${en.text()}`);
  assert.ok(en.text().includes('listening'), `英文横幅应当出现 "listening":\n${en.text()}`);
  assert.ok(!/\p{Script=Han}/u.test(en.text()), `英文横幅里不应有中文:\n${en.text()}`);

  assert.ok(zh.text().includes('已启动'), `中文横幅应当出现 "已启动":\n${zh.text()}`);
  assert.ok(zh.text().includes('监听地址'), `中文横幅应当出现 "监听地址":\n${zh.text()}`);

  // 除标签外，两种语言给出的实际取值必须一致
  for (const value of [url, 'opencode.ai', '__llm_session_proxy__/status']) {
    assert.ok(en.text().includes(value) && zh.text().includes(value), `两种语言的横幅都应包含 ${value}`);
  }
});
