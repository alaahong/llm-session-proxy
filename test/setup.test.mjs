import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildConfig, parseJsonLoose } from '../src/config.js';
import { MESSAGE_KEYS, MESSAGES, setLang } from '../src/messages.js';
import {
  COPILOT_CREDENTIAL_ENVS,
  GO_INFERENCE_BASE,
  GO_MODELS_URL,
  SETUP_PRESETS,
  buildPresetConfig,
  inspectCopilotCredential,
  renderPresetConfig,
  runSetup,
  updateConfigModels,
} from '../src/setup.js';

const capture = () => {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    text: () => ({ out: out.join(''), err: err.join('') }),
  };
};

test('预设清单只有两个，且都显式区分官方与社区', () => {
  assert.deepEqual(SETUP_PRESETS, ['opencode-go', 'copilot']);
  assert.equal(buildPresetConfig('opencode-go').notes.official, true);
  assert.equal(buildPresetConfig('copilot').notes.official, false);
});

test('Go 预设用官方 base URL 并注入 session 头', () => {
  const { config } = buildPresetConfig('opencode-go');
  assert.equal(config.upstream.host, 'opencode.ai');
  // provider paths 是绝对路径、会整体替换 targetPath，顶层 basePath 必须留空避免重复前缀
  assert.equal(config.upstream.basePath, '');
  assert.equal(config.upstreams.providers['opencode-go'].paths.chat, '/inference/go/openai/v1/chat/completions');
  assert.equal(config.inject.headers['x-opencode-session'], '{{session.id}}');
  assert.equal(config.session.enabled, true);
  assert.equal(config.request.forwardClientSessionHeaders, false, '客户端头不可信，必须自己生成');
  assert.equal(config.upstreams.providers['opencode-go'].baseUrl, 'https://opencode.ai');
  assert.equal(`${config.upstreams.providers['opencode-go'].baseUrl}${config.upstreams.providers['opencode-go'].paths.chat}`, `${GO_INFERENCE_BASE}/openai/v1/chat/completions`);
  assert.equal(config.upstreams.providers['opencode-go'].auth.env, 'OPENCODE_API_KEY');
});

test('Copilot 预设只写凭据来源，不写 token 值', () => {
  const { config } = buildPresetConfig('copilot');
  const provider = config.upstreams.providers.copilot;
  assert.equal(provider.type, 'copilot');
  assert.equal(provider.auth.tokenMode, 'direct');
  assert.equal(provider.auth.env, undefined);
  assert.equal(provider.auth.command, undefined);
  assert.ok(!/gh[pou]_|github_pat_|oc_sk_/.test(JSON.stringify(config)), '配置里不能出现任何凭据形态');
  assert.ok(config.upstreams.routes.some((r) => r.model === 'gpt-5'));
});

test('--setup-env 能改 Go 预设的环境变量名', () => {
  const { config, notes } = buildPresetConfig('opencode-go', { tokenEnv: 'MY_GO_KEY' });
  assert.equal(config.upstreams.providers['opencode-go'].auth.env, 'MY_GO_KEY');
  assert.equal(notes.tokenEnv, 'MY_GO_KEY');
});

test('非法环境变量名退回默认值，端口非法直接报错', () => {
  assert.equal(buildPresetConfig('opencode-go', { tokenEnv: 'bad-name!' }).notes.tokenEnv, 'OPENCODE_API_KEY');
  assert.throws(() => buildPresetConfig('opencode-go', { port: 70000 }), /Invalid listen port|监听端口无效/);
  assert.throws(() => buildPresetConfig('nope'), /Unknown preset|未知预设/);
});

test('两份预设配置都能通过正式 config 校验', () => {
  for (const preset of SETUP_PRESETS) {
    const { config } = buildPresetConfig(preset);
    const built = buildConfig({ flags: config });
    assert.equal(built.upstreams.enabled, true, `${preset} 应启用上游池`);
    assert.equal(built.upstreams.default, preset === 'copilot' ? 'copilot' : 'opencode-go');
  }
});

test('生成的 JSONC 注释可被正式配置解析器读回', () => {
  for (const preset of SETUP_PRESETS) {
    const text = renderPresetConfig(buildPresetConfig(preset));
    assert.equal(text.split('\n')[0], '{', 'JSONC 外层花括号必须在首行');
    assert.match(text.split('\n')[1], /^\s*\/\//, '注释应在花括号内首行');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-setup-'));
    const file = path.join(tmp, 'config.json');
    try {
      fs.writeFileSync(file, text, 'utf8');
      const built = buildConfig({ file });
      assert.equal(built.upstreams.enabled, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('凭据探测：环境变量优先，且 classic PAT 被标记为不支持', () => {
  const env = { COPILOT_GITHUB_TOKEN: 'ghp_123' };
  const result = inspectCopilotCredential({ env, withGh: null });
  assert.equal(result.source, 'env:COPILOT_GITHUB_TOKEN');
  assert.equal(result.kind, 'classic-pat');
  assert.equal(result.supported, false);
});

test('凭据探测：fine-grained PAT 被标记为支持', () => {
  const env = { GH_TOKEN: 'github_pat_123' };
  const result = inspectCopilotCredential({ env, withGh: null });
  assert.equal(result.kind, 'fine-grained-pat');
  assert.equal(result.supported, true);
});

test('凭据探测：环境变量缺失时查 gh CLI', async () => {
  const result = await inspectCopilotCredential({
    env: {},
    withGh: async () => ({ token: 'gho_abc', source: 'command:gh' }),
  });
  assert.equal(result.source, 'command:gh');
  assert.equal(result.kind, 'oauth-user');
  assert.equal(result.supported, true);
});

test('凭据探测：gh CLI 没有时回落到凭据文件', async () => {
  const result = await inspectCopilotCredential({
    env: {},
    withGh: async () => null,
    file: '/tmp/unused.json',
    readCredential: () => ({ token: 'ghu_xyz', source: 'file' }),
  });
  assert.equal(result.source, 'file');
  assert.equal(result.kind, 'github-app-user');
  assert.ok(result.checked.includes('file'));
});

test('凭据探测：没有任何来源时如实返回 null', () => {
  const result = inspectCopilotCredential({ env: {}, withGh: null, readCredential: () => null });
  assert.equal(result.source, null);
  assert.deepEqual(result.checked, COPILOT_CREDENTIAL_ENVS.concat('file'));
});

test('向导输出包含准备/流程/验证，Copilot 还明确写出限制', () => {
  for (const lang of ['en', 'zh']) {
    setLang(lang);
    for (const preset of SETUP_PRESETS) {
      const c = capture();
      runSetup({ preset, env: {}, ...c });
      const text = c.text().out + c.text().err;
      assert.ok(/WHAT YOU NEED|你需要准备/.test(text));
      assert.ok(/HOW IT WORKS|关键流程/.test(text));
      assert.ok(/HOW TO VERIFY|验证方式/.test(text));
      if (preset === 'copilot') assert.ok(/IMPORTANT LIMIT|重要限制/.test(c.text().err));
      assert.ok(!/\{(tokenEnv|url|name|source|kind|checked|port)\}/.test(text), '不能有未替换的占位符');
    }
  }
  setLang('en');
});

test('向导拒绝覆盖已有文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-setup-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, 'existing', 'utf8');
  try {
    const c = capture();
    const result = runSetup({ preset: 'opencode-go', target: file, env: {}, ...c });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing');
    assert.match(c.text().err, /Refusing to overwrite|拒绝覆盖/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('向导能写入文件并报告路径', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-setup-'));
  const file = path.join(tmp, 'config.json');
  try {
    const c = capture();
    const result = runSetup({ preset: 'opencode-go', target: file, env: {}, ...c });
    assert.equal(result.ok, true);
    assert.equal(result.target, file);
    assert.ok(fs.existsSync(file));
    assert.match(c.text().out, /Setup config written|配置已写入/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Go 预设检查环境变量是否设置', () => {
  const unset = capture();
  runSetup({ preset: 'opencode-go', env: {}, ...unset });
  assert.match(unset.text().out, /NOT set|未设置/);
  const set = capture();
  runSetup({ preset: 'opencode-go', env: { OPENCODE_API_KEY: 'oc_sk_x' }, ...set });
  assert.match(set.text().out, /is set|已在环境变量/);
});

test('注入模型清单后，配置地图补入完整 id 并写入注释', () => {
  const modelResult = {
    ok: true,
    source: 'live',
    fetchedAt: 1000,
    url: GO_MODELS_URL,
    models: [
      { id: 'glm-5.3', name: 'GLM', recommendedApi: 'chat-completions' },
      { id: 'grok-4.7', name: 'Grok', recommendedApi: 'responses' },
    ],
  };
  const c = capture();
  const result = runSetup({ preset: 'opencode-go', env: {}, modelResult, ...c });
  assert.equal(result.ok, true);
  assert.equal(result.built.config.model.map['glm-5.3'], 'glm-5.3');
  assert.equal(result.built.config.model.map['grok-4.7'], 'grok-4.7');
  assert.match(c.text().out, /available models \(2\)/);
  assert.match(c.text().out, /Added 2 model ids/);
});

test('modelResult 为 null 时向导照常工作（--no-models / copilot）', () => {
  for (const preset of SETUP_PRESETS) {
    const c = capture();
    const result = runSetup({ preset, env: {}, modelResult: null, ...c });
    assert.equal(result.ok, true, preset);
    assert.ok(!/Uncaught|未捕获/.test(c.text().err));
  }
});

test('updateConfigModels 默认写 .updated.json，保留用户别名', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-setup-upd-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ model: { map: { glm: 'glm-5.3', mine: 'custom' } }, listen: { port: 9999 } }), 'utf8');
  const modelResult = {
    ok: true,
    source: 'live',
    fetchedAt: 1000,
    url: GO_MODELS_URL,
    models: [{ id: 'glm-5.3', name: 'GLM' }, { id: 'qwen4-max', name: 'Qwen' }],
  };
  try {
    const c = capture();
    const result = updateConfigModels({ target: file, modelResult, ...c });
    assert.equal(result.ok, true);
    assert.equal(result.target, `${file}.updated.json`);
    const written = parseJsonLoose(fs.readFileSync(result.target, 'utf8'));
    assert.equal(written.model.map.glm, 'glm-5.3');
    assert.equal(written.model.map.mine, 'custom');
    assert.equal(written.model.map['qwen4-max'], 'qwen4-max');
    assert.equal(written.listen.port, 9999);
    assert.equal(fs.readFileSync(file, 'utf8').includes('custom'), true, '原文件未被改动');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateConfigModels --in-place 会留 .bak', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-setup-upd-'));
  const file = path.join(tmp, 'config.json');
  const original = JSON.stringify({ model: { map: {} } });
  fs.writeFileSync(file, original, 'utf8');
  const modelResult = { ok: true, source: 'live', fetchedAt: 1000, models: [{ id: 'glm-5.3', name: 'GLM' }] };
  try {
    const c = capture();
    const result = updateConfigModels({ target: file, modelResult, inPlace: true, ...c });
    assert.equal(result.ok, true);
    assert.equal(result.target, file);
    assert.ok(fs.existsSync(result.backup));
    assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
    assert.match(fs.readFileSync(file, 'utf8'), /glm-5\.3/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateConfigModels 缺文件或缺清单时安全失败', () => {
  const c1 = capture();
  assert.equal(updateConfigModels({ target: null, ...c1 }).ok, false);
  const c2 = capture();
  assert.equal(updateConfigModels({ target: path.join(os.tmpdir(), 'definitely-not-here.json'), ...c2 }).ok, false);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-setup-upd-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, '{}', 'utf8');
  try {
    const c3 = capture();
    assert.equal(updateConfigModels({ target: file, modelResult: null, ...c3 }).ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('en / zh 文案 key 完全对应', () => {
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
  assert.ok(MESSAGE_KEYS.includes('setup.note.go.prepare'));
  assert.equal(GO_MODELS_URL, 'https://opencode.ai/inference/go/v1/models');
});
