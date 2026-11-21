import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t } from './messages.js';

/**
 * 运行时模型清单（setup 向导与配置更新用）。
 *
 * 数据来源只有官方公开端点：`https://opencode.ai/inference/go/v1/models`。
 * 实测无需 Console key 即可 GET（2026-11-21），所以这一层的探测**不带任何凭据**，
 * 与 --doctor 的「只到传输层」约束一致。
 *
 * Copilot 侧没有公开的模型列表 API：官方给的是 copilot CLI 的 /model 选择器与
 * SDK 的 listModels()（进程内 JSON-RPC）。本模块不编造一个端点出来，
 * 而是如实返回 unsupported，让上层提示用户去 CLI 里看。
 *
 * 零依赖：fetch 是 Node 18+ 内置；可注入 fetchImpl 做单测。
 */

export const GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const MODEL_CACHE_FILE = 'model-catalog.json';
/** 缓存有效期：模型清单一天变不了几次，6 小时足够。 */
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 缓存文件路径；与凭据同目录（LSP_HOME 优先，否则 ~/.lsp）。 */
export function modelCachePath(env = process.env) {
  const home = typeof env.LSP_HOME === 'string' && env.LSP_HOME.trim()
    ? env.LSP_HOME.trim()
    : path.join(os.homedir(), '.lsp');
  return path.join(path.resolve(home), MODEL_CACHE_FILE);
}

/** 读缓存。坏了/过期都返回 null，不抛错。 */
export function readModelCache(env = process.env, now = Date.now()) {
  try {
    const file = modelCachePath(env);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed) || !Array.isArray(parsed.models)) return null;
    const fetchedAt = Number(parsed.fetchedAt);
    if (!Number.isFinite(fetchedAt) || now - fetchedAt > MODEL_CACHE_TTL_MS) return null;
    return { models: parsed.models, fetchedAt, url: parsed.url || GO_MODELS_URL, stale: false };
  } catch {
    return null;
  }
}

/** 写缓存。目录不存在就建；写失败不影响本次结果（上层只用内存里的清单）。 */
export function writeModelCache(data, env = process.env) {
  const file = modelCachePath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ fetchedAt: data.fetchedAt, url: data.url || GO_MODELS_URL, models: data.models }, null, 2)}\n`,
      'utf8',
    );
    return file;
  } catch {
    return null;
  }
}

/**
 * 把官方响应收敛成稳定的精简条目。
 * 只保留向导真正用得到的字段，避免把定价倍数之类的细节塞进配置注释。
 */
export function normalizeModels(payload, { fetchedAt = Date.now(), url = GO_MODELS_URL } = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models = rows
    .filter((item) => isPlainObject(item) && typeof item.id === 'string' && item.id)
    .map((item) => ({
      id: item.id,
      name: typeof item.name === 'string' ? item.name : item.id,
      family: typeof item.family === 'string' ? item.family : null,
      context: Number.isFinite(item.limit?.context) ? item.limit.context : null,
      output: Number.isFinite(item.limit?.output) ? item.limit.output : null,
      recommendedApi: typeof item.recommended_api === 'string' ? item.recommended_api : null,
      api: isPlainObject(item.api) ? Object.keys(item.api) : [],
      tools: item.capabilities?.tools?.supported === true,
      reasoning: item.capabilities?.reasoning?.supported === true,
      zdr: item.go?.zdr === true,
      monthlyUsage: isPlainObject(item.go?.monthly_usage) ? { ...item.go.monthly_usage } : null,
    }))
    // 官方清单偶尔重复列同一模型；按 id 去重，保留首条
    .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
  return { models, fetchedAt, url };
}

/**
 * 拉 OpenCode Go 模型清单。失败一律降级为 `{ ok:false, error }`，绝不编造数据。
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用）
 * @param {string} [options.url] 端点（测试可指向本地 mock）
 * @param {number} [options.timeoutMs] 超时
 */
export async function fetchGoModels({
  fetchImpl = globalThis.fetch,
  url = GO_MODELS_URL,
  timeoutMs = 15000,
  fetchedAt = Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, models: [], error: t('models.err.noFetch'), url };
  }
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { ok: false, models: [], error: t('models.err.http', { status: response.status }), url };
    }
    const payload = await response.json();
    const result = normalizeModels(payload, { fetchedAt, url });
    if (!result.models.length) {
      return { ok: false, models: [], error: t('models.err.empty'), url };
    }
    return { ok: true, ...result, source: 'live' };
  } catch (error) {
    return { ok: false, models: [], error: error?.message || String(error), url };
  }
}

/**
 * 按预设取清单。Copilot 没有公开端点，明确返回 unsupported。
 *
 * @returns {{ok: boolean, models: Array, source: 'live'|'cache'|null, error?: string, reason?: string}}
 */
export async function loadPresetModels({
  preset = 'opencode-go',
  env = process.env,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  url = GO_MODELS_URL,
  timeoutMs = 15000,
  allowCache = true,
} = {}) {
  if (preset === 'copilot') {
    return {
      ok: false,
      models: [],
      source: null,
      reason: 'no-public-endpoint',
      error: t('models.err.copilotNoEndpoint'),
    };
  }
  if (preset !== 'opencode-go') {
    return { ok: false, models: [], source: null, reason: 'unknown-preset', error: t('models.err.unknownPreset', { preset }) };
  }

  const live = await fetchGoModels({ fetchImpl, url, timeoutMs, fetchedAt: now });
  if (live.ok) {
    if (allowCache) writeModelCache(live, env);
    return live;
  }

  const cached = readModelCache(env, now);
  if (cached) {
    return { ok: true, ...cached, source: 'cache', stale: true, refreshError: live.error };
  }
  return { ok: false, models: [], source: null, reason: 'fetch-failed', error: live.error };
}

/** 人类可读的一行：id / 名称 / 上下文 / 推荐 API。 */
export function formatModelRow(model) {
  const ctx = model.context ? `${Math.round(model.context / 1000)}k` : '-';
  return `${model.id.padEnd(30)} ${String(model.name).slice(0, 34).padEnd(34)} ${ctx.padStart(6)}  ${model.recommendedApi || '-'}`;
}

/** 完整表格（含表头），给 --models 与 --setup 共用。 */
export function renderModelTable(models, { limit = 0 } = {}) {
  const rows = limit > 0 ? models.slice(0, limit) : models;
  const header = `${'MODEL ID'.padEnd(30)} ${'NAME'.padEnd(34)} ${'CTX'.padStart(6)}  API`;
  return [header, ...rows.map(formatModelRow)].join('\n');
}

/**
 * 把清单合并进 model.map：官方完整 id 作为键（消除 proxy-<id> 的未命中告警），
 * 用户已有的短别名一律保留、不被覆盖。
 */
export function mergeModelMap(existing, models) {
  const out = isPlainObject(existing) ? { ...existing } : {};
  for (const model of models) {
    if (!Object.hasOwn(out, model.id)) out[model.id] = model.id;
  }
  return out;
}

/** 配置注释里的清单块（只写 id 与推荐 API，够选模型用）。 */
export function renderCatalogComment(result) {
  // 调用方可能压根没拉清单（--no-models / copilot 预设），必须容忍 null。
  if (!result || !result.ok || !Array.isArray(result.models) || !result.models.length) return [];
  const when = new Date(result.fetchedAt).toISOString();
  const lines = [
    `  // ── available models (${result.models.length}) — ${result.source === 'cache' ? 'cached' : 'live'} at ${when} ──`,
    `  // source: ${result.url || GO_MODELS_URL}`,
  ];
  for (const model of result.models) {
    lines.push(`  //   ${model.id}${model.recommendedApi && model.recommendedApi !== 'chat-completions' ? `  [${model.recommendedApi}]` : ''}`);
  }
  return lines;
}
