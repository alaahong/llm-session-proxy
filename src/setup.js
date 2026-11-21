import fs from 'node:fs';
import path from 'node:path';

import { parseJsonLoose } from './config.js';
import { classifyToken, credentialFilePath, readStoredCredential, tokenFromEnv } from './copilot.js';
import { t } from './messages.js';
import { GO_MODELS_URL as MODELS_URL, loadPresetModels, mergeModelMap, renderCatalogComment } from './model-catalog.js';

/**
 * 一键接入向导（v0.4 预研）。
 *
 * 边界必须写清楚——这是本模块存在的前提：
 *
 * - **OpenCode Go：官方支持。** 官方文档给出 Console API key（`oc_sk_...`）与
 *   `https://opencode.ai/inference/go` base URL，并**明确要求**客户端发送稳定的
 *   `x-opencode-session`。本代理的本职就是补这个头，所以预制配置是真正的一键。
 *   实测：不带该头的 POST 会回 400 MissingSessionID（2026-11-21）。
 * - **GitHub Copilot：认证可预制，转发路径不是官方契约。** 官方给的是
 *   `copilot login`（设备流）+ 环境变量 + gh CLI 回退，以及进程内 JSON-RPC 的
 *   SDK；官方**没有**把 `api.githubcopilot.com/chat/completions` 承诺为任意第三方
 *   代理可调用的 HTTP API。本代理的 copilot provider 走的是社区通行路径，
 *   所以向导会照实标注，而不是把它包装成官方一键。
 *
 * 因此向导只做两件可自证的事：
 *   1. 按预设生成配置（凭据**只写来源名**，绝不写值）；
 *   2. 探测本机凭据来源是否齐备（纯本地读取 + gh CLI 取 token，不发模型请求）。
 *
 * 真正的连通性验证交给 `--doctor`（它会做传输层探测），两者不混在一起。
 */

/** 预设名。顺序即帮助文本里的展示顺序。 */
export const SETUP_PRESETS = ['opencode-go', 'copilot'];

/** 官方端点常量——都来自官方页面，不用照抄第三方文章。 */
export const GO_INFERENCE_BASE = 'https://opencode.ai/inference/go';
export const COPILOT_API_BASE = 'https://api.githubcopilot.com';
// GO_MODELS_URL 与模型清单工具函数统一由 model-catalog.js 持有，这里重导出保持兼容。
export { GO_MODELS_URL } from './model-catalog.js';

/** Copilot 凭据来源探测顺序（与官方 CLI / SDK 一致）。 */
export const COPILOT_CREDENTIAL_ENVS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 预设 -> 配置片段 + 说明。
 *
 * @param {string} preset        预设名
 * @param {object} [options]
 * @param {string} [options.tokenEnv]  Go 预设读取 Console key 的环境变量名
 * @param {number|string} [options.port] 监听端口
 * @returns {{preset: string, config: object, notes: object}}
 */
export function buildPresetConfig(preset, { tokenEnv = 'OPENCODE_API_KEY', port = 9355 } = {}) {
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error(t('setup.err.badPort', { value: String(port) }));
  }
  const envName = typeof tokenEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/i.test(tokenEnv.trim())
    ? tokenEnv.trim()
    : 'OPENCODE_API_KEY';

  if (preset === 'opencode-go') {
    // 注意 basePath 用官方新路径 /inference/go/openai：
    // 老样例里的 /zen/go/v1 目前仍可用（实测同样回 MissingSessionID），
    // 但官方文档已改成 /inference/go/<api>/v1/...，新配置跟官方走。
    return {
      preset,
      config: {
        listen: { host: '127.0.0.1', port: listenPort },
        upstream: {
          protocol: 'https',
          host: 'opencode.ai',
          basePath: '',
        },
        request: { bufferBody: true, timeoutMs: 600000, forwardClientSessionHeaders: false },
        session: {
          enabled: true,
          headerNames: ['x-opencode-session'],
          bodyFields: [],
          contentHash: { enabled: true, fields: ['system'], includeFirstUserMessage: true },
          idPrefix: 'ses_',
          idFormat: 'hex26',
          requestIdFormat: 'msg_{{session.count}}',
        },
        inject: {
          headers: {
            'x-opencode-session': '{{session.id}}',
            'x-opencode-request': '{{session.requestId}}',
            'x-opencode-client': 'llm-session-proxy',
          },
          overwrite: true,
        },
        model: { enabled: true, field: 'model', stripPrefixes: ['proxy-'], map: {} },
        userAgent: 'llm-session-proxy/1.0',
        userAgentMode: 'replace',
        response: { stream: true },
        // 凭据只写来源名：值由环境提供，永不落进配置文件。
        upstreams: {
          enabled: true,
          providers: {
            'opencode-go': {
              type: 'openai',
              baseUrl: 'https://opencode.ai',
              auth: { env: envName },
              // 上游池命中时 provider 的 paths 会整体替换 targetPath 并跳过
              // upstream.basePath，所以这里必须写**完整绝对路径**。
              paths: {
                chat: '/inference/go/openai/v1/chat/completions',
                responses: '/inference/go/openai/v1/responses',
              },
            },
          },
          default: 'opencode-go',
        },
      },
      notes: {
        official: true,
        tokenEnv: envName,
        prepare: 'setup.note.go.prepare',
        flow: 'setup.note.go.flow',
        verify: 'setup.note.go.verify',
        limit: null,
      },
    };
  }

  if (preset === 'copilot') {
    // Copilot 凭据走内置链（env → gh CLI → 凭据文件 → 可选设备流），
    // 所以 auth 里一个 token 值都不出现。tokenMode 保持 direct。
    return {
      preset,
      config: {
        listen: { host: '127.0.0.1', port: listenPort },
        request: { bufferBody: true, timeoutMs: 600000, forwardClientSessionHeaders: false },
        session: { enabled: true, idPrefix: 'ses_', idFormat: 'hex26' },
        model: { enabled: true, field: 'model', stripPrefixes: ['proxy-'], map: {} },
        response: { stream: true },
        upstreams: {
          enabled: true,
          providers: {
            copilot: {
              type: 'copilot',
              baseUrl: COPILOT_API_BASE,
              auth: { tokenMode: 'direct' },
            },
          },
          routes: [
            { model: 'gpt-5', upstream: 'copilot' },
            { model: 'codex', upstream: 'copilot' },
            { model: 'o1', upstream: 'copilot' },
            { model: 'o3', upstream: 'copilot' },
            { model: 'o4', upstream: 'copilot' },
          ],
          default: 'copilot',
        },
      },
      notes: {
        official: false,
        tokenEnv: COPILOT_CREDENTIAL_ENVS.join(' | '),
        prepare: 'setup.note.copilot.prepare',
        flow: 'setup.note.copilot.flow',
        verify: 'setup.note.copilot.verify',
        limit: 'setup.note.copilot.limit',
      },
    };
  }

  throw new Error(t('setup.err.unknownPreset', { preset, known: SETUP_PRESETS.join(' | ') }));
}

/**
 * 探测本机 Copilot 凭据来源。只读，不发网络请求、不回显 token。
 *
 * @returns {{source: string|null, kind: string, supported: boolean, file: string, checked: string[]}}
 */
export function inspectCopilotCredential({
  env = process.env,
  withGh = async () => null,
  file = credentialFilePath(env),
  readCredential = readStoredCredential,
  fromEnv = tokenFromEnv,
} = {}) {
  const checked = [...COPILOT_CREDENTIAL_ENVS];
  const found = fromEnv(env);
  if (found) {
    const shape = classifyToken(found.token);
    return {
      source: found.source,
      kind: shape.kind,
      supported: shape.supported,
      file,
      checked,
    };
  }
  if (withGh) {
    // withGh 的返回值形如 { token, source }；这里只看形态，不保留值
    // （调用方负责把 gh CLI 的 stdout 交给它）。
    return withGh().then((fromCli) => {
      if (fromCli?.token) {
        const shape = classifyToken(fromCli.token);
        return {
          source: fromCli.source || 'command:gh',
          kind: shape.kind,
          supported: shape.supported,
          file,
          checked,
        };
      }
      return inspectFile();
    });
  }
  return inspectFile();

  function inspectFile() {
    checked.push('file');
    const saved = readCredential(env);
    if (saved?.token) {
      const shape = classifyToken(saved.token);
      return { source: 'file', kind: shape.kind, supported: shape.supported, file, checked };
    }
    return { source: null, kind: 'none', supported: false, file, checked };
  }
}

/**
 * 生成可直接落盘的 JSONC 配置文本（带人话注释，沿用 examples 的风格）。
 */
export function renderPresetConfig(built, modelResult = null) {
  const head = [
    '{',
    `  // ${t('setup.config.generated', { preset: built.preset })}`,
    '  // Credentials are never stored here — only the source name is written.',
    ...renderCatalogComment(modelResult),
    '',
  ];
  const body = JSON.stringify(built.config, null, 2)
    .split('\n')
    .slice(1, -1)
    .map((line) => `  ${line}`)
    .join('\n');
  return `${head.join('\n')}${body}\n}\n`;
}

/**
 * 向导主入口：生成配置（可选落盘）+ 输出「准备 / 流程 / 验证 / 限制」清单。
 *
 * 不做交互式提问——本项目是零依赖 CLI，且 token 不该出现在命令行历史里。
 * 认证信息通过环境变量名填写；Copilot 用官方 `copilot login` / `gh auth login`。
 */
export function runSetup({
  preset,
  target = null,
  tokenEnv,
  port = 9355,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fsApi = fs,
  credential,
  withGh = null,
  modelResult = null,
} = {}) {
  if (!preset) {
    stderr.write(`${t('setup.err.needPreset', { known: SETUP_PRESETS.join(' | ') })}\n`);
    return { ok: false };
  }
  let built;
  try {
    built = buildPresetConfig(preset, { tokenEnv, port });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return { ok: false, error };
  }

  // 模型清单（由 CLI 预先拉取并注入）：只加完整 id -> id 的映射，
  // 用户已有的短别名一律保留。Copilot 无公开清单，如实说明。
  let modelCount = 0;
  if (modelResult?.ok && modelResult.models?.length) {
    built.config.model.map = mergeModelMap(built.config.model.map, modelResult.models);
    modelCount = modelResult.models.length;
  }

  if (target) {
    const absolute = path.resolve(target);
    if (fsApi.existsSync(absolute)) {
      stderr.write(`${t('setup.err.fileExists', { target: absolute })}\n`);
      return { ok: false, error: new Error('file exists') };
    }
    fsApi.writeFileSync(absolute, renderPresetConfig(built, modelResult), 'utf8');
    stdout.write(`${t('setup.written', { target: absolute })}\n`);
  } else {
    stdout.write(`${renderPresetConfig(built, modelResult)}\n`);
  }
  if (modelCount) stdout.write(`\n${t('models.note.setupAdded', { count: modelCount })}\n`);

  // note 文案里的占位符在这里统一插值：t() 不会替嵌套调用自动传参。
  const noteVars = {
    tokenEnv: built.notes.tokenEnv,
    url: MODELS_URL,
    port: built.config.listen.port,
    name: built.notes.tokenEnv,
  };
  stdout.write(`\n${t('setup.section.prepare')}\n${t(built.notes.prepare, noteVars)}\n`);
  stdout.write(`\n${t('setup.section.flow')}\n${t(built.notes.flow, noteVars)}\n`);
  stdout.write(`\n${t('setup.section.verify')}\n${t(built.notes.verify, noteVars)}\n`);
  if (built.notes.limit) {
    stderr.write(`\n${t('setup.section.limit')}\n${t(built.notes.limit, noteVars)}\n`);
  }

  let cred = null;
  if (preset === 'copilot') {
    cred = credential || inspectCopilotCredential({ env, withGh });
    if (cred && typeof cred.then === 'function') {
      return cred.then((result) => finish(result));
    }
    return finish(cred);
  }

  return finish(cred);

  function finish(credResult) {
    if (preset === 'opencode-go') {
      const configured = typeof env[built.notes.tokenEnv] === 'string' && env[built.notes.tokenEnv].trim();
      stdout.write(`\n${t(configured ? 'setup.check.go.envOk' : 'setup.check.go.envMissing', { name: built.notes.tokenEnv })}\n`);
      return { ok: true, built, target, credential: null, envReady: Boolean(configured) };
    }
    if (credResult?.source) {
      const msg = credResult.supported
        ? t('setup.check.copilot.ok', { source: credResult.source, kind: credResult.kind })
        : t('setup.check.copilot.unsupported', { source: credResult.source, kind: credResult.kind });
      (credResult.supported ? stdout : stderr).write(`\n${msg}\n`);
    } else {
      stderr.write(`\n${t('setup.check.copilot.missing', { checked: credResult?.checked?.join(' | ') || '' })}\n`);
    }
    return { ok: true, built, target, credential: credResult, envReady: Boolean(credResult?.source) };
  }
}

/**
 * 用当前模型清单刷新一份已有配置：
 *   - 现有 model.map 里的短别名**一条不动**；
 *   - 官方完整 id 以 id -> id 追加（消除 proxy-<id> 的未命中告警）；
 *   - 文件头加一段带时间戳的清单注释；
 *   - 默认写 <file>.updated.json；--in-place 才覆盖原文件，且先留 .bak。
 *
 * 返回 { ok, target, count, backup }。任何一步失败都不动原文件。
 */
export function updateConfigModels({
  target,
  modelResult,
  inPlace = false,
  fsApi = fs,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!target) {
    stderr.write(`${t('models.err.needFile')}\n`);
    return { ok: false };
  }
  if (!fsApi.existsSync(target)) {
    stderr.write(`${t('models.err.fileMissing', { target })}\n`);
    return { ok: false };
  }
  if (!modelResult?.ok || !modelResult.models?.length) {
    stderr.write(`${t('models.err.noModels')}\n`);
    return { ok: false };
  }

  let raw;
  try {
    // 用宽松解析器读，保留用户原来的 JSONC 注释风格无关紧要——
    // 写回时统一输出标准 JSON + 自动生成的清单注释。
    raw = parseJsonLoose(fsApi.readFileSync(target, 'utf8'), target);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return { ok: false, error };
  }
  if (!isPlainObject(raw)) {
    stderr.write(`${t('setup.err.fileExists', { target })}\n`);
    return { ok: false };
  }

  const merged = mergeModelMap(raw.model?.map, modelResult.models);
  const next = { ...raw, model: { ...(isPlainObject(raw.model) ? raw.model : {}), map: merged } };
  const lines = renderCatalogComment(modelResult);
  const text = [
    '{',
    `  // ${t('setup.config.generated', { preset: 'models update' })}`,
    ...lines,
    '',
    ...JSON.stringify(next, null, 2).split('\n').slice(1, -1).map((line) => `  ${line}`),
    '}\n',
  ].join('\n');

  const absolute = path.resolve(target);
  const destination = inPlace ? absolute : `${absolute}.updated.json`;
  let backup = null;
  try {
    if (inPlace && fsApi.existsSync(absolute)) {
      backup = `${absolute}.bak`;
      fsApi.writeFileSync(backup, fsApi.readFileSync(absolute), 'utf8');
    }
    fsApi.writeFileSync(destination, text, 'utf8');
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return { ok: false, error };
  }
  stdout.write(`${t('models.updated', { target: destination, count: modelResult.models.length })}\n`);
  if (backup) stdout.write(`${t('models.updated.backup', { backup })}\n`);
  if (!inPlace) stdout.write(`${t('models.note.inPlaceHint')}\n`);
  return { ok: true, target: destination, count: modelResult.models.length, backup };
}
