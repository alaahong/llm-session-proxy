import { execFile } from 'node:child_process';

import { t } from './messages.js';

/**
 * 上游池（v0.3.0）。
 *
 * 存在的理由：v0.2 只有一个 `upstream`（host + port + basePath），所有请求打同一个地方。
 * 但真实需求是「同一个客户端，让便宜模型干杂活、贵模型干难题，而且**有的活走
 * Copilot 订阅、有的活走自己的 API key**」。这就需要多个上游，且要能按模型挑。
 *
 * 三个刻意的设计取舍：
 *
 * 1. **上游池与 router 分桶正交。** router 决定「用哪个模型」，上游池决定「发到哪」。
 *    两者各跑一遍，互不干扰：同一个模型可以走不同上游（取决于桶或模型前缀），
 *    同一个上游也可以服务不同难度的模型。
 * 2. **provider 声明自己的 wire 协议。** 不写死「这个上游只说 chat」——Copilot 会
 *    按模型在 chat / responses 之间切换，Gemini 说的是自己那套。wire 是 provider 的属性。
 * 3. **凭据不落配置、不进日志。** provider 只声明「凭据从哪来」（环境变量名 / 命令），
 *    值在运行时现取。配置文件里存 token 等于把密钥躺在磁盘上等着被误提交。
 *
 * 本模块是纯函数 + 少量 IO（凭据读取），不打日志，便于单测与 doctor 复用。
 */

/** 支持的 provider 类型。 */
export const PROVIDER_TYPES = ['openai', 'anthropic', 'gemini', 'copilot', 'custom'];

/** provider 类型默认支持的 wire 协议。 */
const DEFAULT_WIRE = {
  openai: ['chat', 'responses'],
  anthropic: ['messages'],
  gemini: ['gemini'],
  copilot: ['chat', 'responses'],
  custom: ['chat'],
};

/**
 * 各 provider 类型的默认端点路径。
 * 路径是**相对 baseUrl** 的：baseUrl 写 https://api.openai.com/v1 + 路径 /chat/completions
 * → 最终请求 https://api.openai.com/v1/chat/completions。
 */
const DEFAULT_PATHS = {
  openai: { chat: '/chat/completions', responses: '/responses' },
  anthropic: { messages: '/messages' },
  gemini: { gemini: '/v1beta/models/{model}:{stream}' },
  copilot: { chat: '/chat/completions', responses: '/responses' },
  custom: { chat: '/chat/completions' },
};

/**
 * Copilot 侧：只有 gpt-5 家族与 Codex 变体走 /responses，其余走 /chat/completions。
 * 走错端点上游直接 400，所以这个判定必须是数据而不是配置。
 */
const COPILOT_RESPONSES_ONLY = /^(gpt-5|codex|o[134])/i;

/**
 * api.githubcopilot.com 的 API 版本。
 *
 * 2022-11-28 是 api.github.com REST 的版本词汇，发给 Copilot API 会得到
 * `400 invalid apiVersion`。2026-08-01 是 Copilot 当前接受的版本。
 */
export const COPILOT_API_VERSION = '2026-08-01';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 归一化一个 provider 定义。
 * 类型不对时**原样返回**，交给 validate 报错——静默退回默认值与「配了但没生效」同坑。
 */
export function normalizeProvider(name, provider) {
  if (!isPlainObject(provider)) return provider;
  const out = { ...provider };
  out.name = name;
  // 类型不对时**原样保留**，交给 config 校验报错——静默当成 openai 的话，
  // 用户以为自己配的是 gemini，请求却全按 openai 的端点发出去了。
  out.type = typeof provider.type === 'string' ? provider.type : (provider.type === undefined ? 'openai' : provider.type);

  const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : '';
  out.baseUrl = baseUrl.replace(/\/+$/, '');

  // 端点路径：provider 自带 > 类型默认
  // 用 hasOwn 取默认值：直接 DEFAULT_PATHS[type] 会撞上 __proto__ 之类的原型键
  const paths = { ...(Object.hasOwn(DEFAULT_PATHS, out.type) ? DEFAULT_PATHS[out.type] : {}) };
  if (isPlainObject(provider.paths)) {
    for (const [key, value] of Object.entries(provider.paths)) {
      // 值不是非空字符串时**原样保留**，交给 config 校验报错：
      // 静默丢掉等于「配了但没生效」，请求会打到默认端点上。
      paths[key] = value;
    }
  }
  out.paths = paths;

  // 支持的 wire 协议
  const wires = Array.isArray(provider.wire)
    ? provider.wire.filter((item) => typeof item === 'string' && item)
    : typeof provider.wire === 'string' && provider.wire
      ? [provider.wire]
      : [...(Object.hasOwn(DEFAULT_WIRE, out.type) ? DEFAULT_WIRE[out.type] : ['chat'])];
  out.wire = wires;

  // 凭据来源：只记「从哪拿」，不记值
  if (isPlainObject(provider.auth)) {
    const auth = { ...provider.auth };
    if (typeof auth.env === 'string') auth.env = auth.env.trim();
    else delete auth.env;
    if (typeof auth.header === 'string') auth.header = auth.header.trim().toLowerCase();
    else delete auth.header;
    if (typeof auth.prefix === 'string') auth.prefix = auth.prefix;
    else delete auth.prefix;
    if (typeof auth.command === 'string') auth.command = auth.command.trim();
    else delete auth.command;
    // allowCommand: false 表示「不许执行任何命令取凭据」。
    // Copilot 默认会兜底去问 gh CLI，用户想彻底关掉就写这个开关。
    if (typeof auth.allowCommand === 'boolean') auth.allowCommand = auth.allowCommand;
    else delete auth.allowCommand;
    // Copilot 专有：direct（默认）直连 GitHub token，session 换短命 session token。
    // 非字符串原样留下，交给 config 校验报错——不能静默退回 direct。
    if (typeof auth.tokenMode === 'string') auth.tokenMode = auth.tokenMode.trim().toLowerCase();
    else if (auth.tokenMode === null) delete auth.tokenMode;
    out.auth = auth;
  } else if (provider.auth === undefined || provider.auth === null) {
    // 没写凭据是允许的：本地 Ollama / LM Studio 这类端点不需要 key
    out.auth = null;
  } else {
    // 凭据段写错了：原样保留，交给 config 校验报错。
    // 静默当成「没有凭据」的话，请求会带着空凭据发出去，要等上游回 401 才发现。
    out.auth = provider.auth;
  }

  // 模型前缀 → 这个上游用哪个 wire 协议。Copilot 需要它，其余类型一般不用。
  const modelWire = {};
  if (isPlainObject(provider.modelWire)) {
    for (const [key, value] of Object.entries(provider.modelWire)) {
      if (typeof key === 'string' && key && typeof value === 'string' && value) modelWire[key] = value;
    }
  }
  out.modelWire = modelWire;

  // 静态请求头（不含凭据）
  out.headers = {};
  if (isPlainObject(provider.headers)) {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof key === 'string' && key && typeof value === 'string') out.headers[key] = value;
    }
  }

  out.fallback = provider.fallback === true;
  return out;
}

/** 归一化整池。 */
export function normalizeUpstreams(upstreams) {
  if (!isPlainObject(upstreams)) return upstreams;
  const out = { ...upstreams };
  const providers = {};
  const source = isPlainObject(upstreams.providers) ? upstreams.providers : {};
  for (const [name, provider] of Object.entries(source)) {
    providers[name] = normalizeProvider(name, provider);
  }
  // providers 段写错了（不是对象）：原样保留，交给 config 校验报错。
  // 静默当成空池的话，用户配的上游会被整个忽略，请求全发到旧的上游去。
  out.providers = upstreams.providers !== undefined && !isPlainObject(upstreams.providers)
    ? upstreams.providers
    : providers;

  out.routes = (Array.isArray(upstreams.routes) ? upstreams.routes : []).map((route) => {
    if (!isPlainObject(route)) return route;
    const clean = { ...route };
    if (typeof clean.model === 'string') clean.model = clean.model.trim();
    if (typeof clean.upstream === 'string') clean.upstream = clean.upstream.trim();
    return clean;
  });

  out.default = typeof upstreams.default === 'string' ? upstreams.default.trim() : null;
  out.enabled = upstreams.enabled !== false;
  return out;
}

/**
 * 选上游。三档兜底，与 router 的 forced > 规则 > default 是同一套语义：
 *   1. 桶里显式写了 upstream —— 最高优先（用户点名了）；
 *   2. 按模型名前缀查 routes —— 自上而下、首个命中即止；
 *   3. 池的 default —— 兜底。
 * 都不命中返回 null，调用方回退到旧的 config.upstream（保持向后兼容）。
 *
 * 匹配用**两个候选**：客户端原始名与解析后的真实 ID。
 * 用户写规则时心里想的可能是 `proxy-gpt-5`，也可能是 `gpt-5`——两个都试。
 */
export function resolveUpstream({ model, clientModel, bucketUpstream, upstreamConfig }) {
  const pool = upstreamConfig || {};
  const providers = isPlainObject(pool.providers) ? pool.providers : {};

  if (typeof bucketUpstream === 'string' && bucketUpstream) {
    const provider = providers[bucketUpstream];
    if (provider) {
      return { name: bucketUpstream, provider, source: 'bucket', index: null };
    }
    return { name: bucketUpstream, provider: null, source: 'bucket', index: null, missing: true };
  }

  const routes = Array.isArray(pool.routes) ? pool.routes : [];
  const candidates = [clientModel, model].filter((value) => typeof value === 'string' && value);
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    if (!route || typeof route.upstream !== 'string' || !route.upstream) continue;
    const prefix = typeof route.model === 'string' ? route.model : '';
    const hit = prefix ? candidates.some((value) => value.startsWith(prefix)) : true;
    if (hit) {
      const provider = providers[route.upstream];
      return { name: route.upstream, provider: provider || null, source: 'rule', index, missing: !provider };
    }
  }

  if (typeof pool.default === 'string' && pool.default) {
    const provider = providers[pool.default];
    return { name: pool.default, provider: provider || null, source: 'default', index: null, missing: !provider };
  }

  return { name: null, provider: null, source: 'none', index: null };
}

/**
 * 这个 provider 该用哪套 wire 协议。
 *
 * 优先级：modelWire 前缀命中 > provider 声明的 wire 列表（取第一个）> 'chat'。
 * Copilot 的 modelWire 是内置的：gpt-5 家族与 Codex 变体必须走 responses。
 */
export function resolveWire(provider, model) {
  if (!isPlainObject(provider)) return { wire: 'chat', source: 'default' };

  const candidate = typeof model === 'string' ? model : '';
  const modelWire = isPlainObject(provider.modelWire) ? provider.modelWire : {};
  const prefixes = Object.keys(modelWire).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (candidate.startsWith(prefix)) {
      return { wire: modelWire[prefix], source: 'modelWire' };
    }
  }

  // Copilot 的内建判定：只有 gpt-5 家族与 Codex 变体走 responses
  if (provider.type === 'copilot' && !Object.keys(modelWire).length) {
    if (COPILOT_RESPONSES_ONLY.test(candidate)) {
      return { wire: 'responses', source: 'copilot' };
    }
    return { wire: 'chat', source: 'copilot' };
  }

  const wires = Array.isArray(provider.wire) ? provider.wire : [];
  if (wires.length) return { wire: wires[0], source: 'provider' };
  return { wire: 'chat', source: 'default' };
}

/**
 * provider 的端点路径。
 *
 * Gemini 的路径有两个占位符：{model} 是模型名，{stream} 决定用哪个方法
 * （generateContent 还是 streamGenerateContent）。流式还要额外加 alt=sse，
 * 否则上游回的是 JSON 数组而不是 SSE 事件流。
 */
export function upstreamPathFor(provider, wire, { model, stream } = {}) {
  if (!isPlainObject(provider)) return null;
  let path = provider.paths?.[wire];
  if (typeof path !== 'string' || !path) return null;
  if (path.includes('{model}')) {
    path = path.replace('{model}', encodeURIComponent(model || 'model'));
  }
  if (path.includes('{stream}')) {
    path = path.replace('{stream}', stream ? 'streamGenerateContent' : 'generateContent');
  }
  // Gemini 的流式端点要显式声明 alt=sse，否则上游回的是 JSON 数组而不是 SSE
  if (provider.type === 'gemini' && stream && !path.includes('alt=sse')) {
    path += (path.includes('?') ? '&' : '?') + 'alt=sse';
  }
  return path;
}

/**
 * 凭据的查找顺序。**只返回「从哪来」，不返回值**——
 * 值由调用方在运行时现取，这样日志与 doctor 都不会碰到密钥。
 *
 * 顺序与 GitHub 官方 Copilot SDK 的优先级一致：
 *   COPILOT_GITHUB_TOKEN → GH_TOKEN → GITHUB_TOKEN → gh CLI → 设备流登录
 */
export function credentialSources(provider) {
  if (!isPlainObject(provider)) return [];
  const auth = isPlainObject(provider.auth) ? provider.auth : {};
  const sources = [];

  if (typeof auth.env === 'string' && auth.env) {
    for (const name of auth.env.split(',').map((item) => item.trim()).filter(Boolean)) {
      sources.push({ kind: 'env', name });
    }
  }
  if (typeof auth.command === 'string' && auth.command) {
    sources.push({ kind: 'command', command: auth.command });
  }
  if (auth.deviceFlow === true) {
    sources.push({ kind: 'deviceFlow' });
  }
  return sources;
}

/**
 * provider 的静态请求头（不含凭据头）。
 * Copilot 需要的固定头在这里补齐——少一个就 403。
 */
export function providerHeaders(provider) {
  if (!isPlainObject(provider)) return {};
  const out = {};
  for (const [key, value] of Object.entries(provider.headers || {})) {
    out[key.toLowerCase()] = value;
  }

  if (provider.type === 'copilot') {
    // Copilot-Integration-Id 必须是 copilot-developer-cli：
    // 这是 Copilot API 对 OAuth token 与 PAT 都接受的那个值，
    // 而 vscode-chat 对 PAT 会被拒。
    if (!out['copilot-integration-id']) out['copilot-integration-id'] = 'copilot-developer-cli';
    if (!out['editor-version']) out['editor-version'] = 'vscode/1.95.0';
    if (!out['editor-plugin-version']) out['editor-plugin-version'] = 'copilot-chat/0.26.7';
    if (!out['user-agent']) out['user-agent'] = 'GitHubCopilotChat/0.26.7';
    if (!out['x-github-api-version']) out['x-github-api-version'] = COPILOT_API_VERSION;
  }

  return out;
}

/** provider 的人类可读摘要，给 doctor 用。 */
export function describeProvider(provider) {
  if (!isPlainObject(provider)) return { name: null, type: null, baseUrl: null, wire: [], credential: null, tokenMode: null };
  const sources = credentialSources(provider);
  const auth = isPlainObject(provider.auth) ? provider.auth : {};
  let credential = null;
  if (auth.env) credential = `env:${auth.env}`;
  else if (auth.command) credential = `cmd:${auth.command}`;
  else if (auth.deviceFlow) credential = 'device-flow';
  else if (sources.length) credential = sources.map((s) => s.kind).join('|');
  return {
    name: provider.name || null,
    type: provider.type || null,
    baseUrl: provider.baseUrl || null,
    wire: Array.isArray(provider.wire) ? provider.wire : [],
    credential,
    tokenMode: provider.type === 'copilot' ? auth.tokenMode || 'direct' : null,
    paths: Object.keys(provider.paths || {}),
  };
}

/** 池里所有 provider 的摘要，给 doctor 用。 */
export function describeUpstreams(upstreamConfig) {
  const providers = isPlainObject(upstreamConfig?.providers) ? upstreamConfig.providers : {};
  return Object.keys(providers).map((name) => describeProvider(providers[name]));
}

/**
 * 凭据头该放在哪个头上、带什么前缀。
 *
 * 默认按 provider 类型给：Gemini 用 x-goog-api-key（不带 Bearer），
 * Anthropic 用 x-api-key，其余走 Authorization: Bearer。
 * 用户可以在 auth.header / auth.prefix 里显式覆盖。
 */
export function credentialHeaderSpec(provider) {
  const auth = isPlainObject(provider?.auth) ? provider.auth : {};
  const type = provider?.type;

  const defaults = {
    gemini: { header: 'x-goog-api-key', prefix: '' },
    anthropic: { header: 'x-api-key', prefix: '' },
  };
  const fallback = { header: 'authorization', prefix: 'Bearer ' };
  const base = defaults[type] || fallback;

  const header = typeof auth.header === 'string' && auth.header ? auth.header.toLowerCase() : base.header;
  let prefix = typeof auth.prefix === 'string' ? auth.prefix : base.prefix;
  if (!prefix && header === 'authorization') prefix = 'Bearer ';
  return { header, prefix };
}

/**
 * 从环境变量里取 API key。
 * auth.env 允许写逗号分隔的多个变量名，按顺序取第一个非空的。
 */
export function apiKeyFromEnv(provider, env = process.env) {
  const auth = isPlainObject(provider?.auth) ? provider.auth : {};
  if (typeof auth.env !== 'string' || !auth.env) return null;
  for (const name of auth.env.split(',').map((item) => item.trim()).filter(Boolean)) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * 从命令取 API key。
 *
 * auth.command 是一条命令（比如 `op read op://vault/item/credential`），
 * 它的 **stdout** 就是 key。命令是配置里写的字符串，不经 shell 展开，
 * 因此用 execFile 直接跑，避免注入。
 *
 * 命令失败（不存在、退出码非 0、空输出）一律当作「没拿到」——
 * 凭据问题应该由上游回 401，而不是让代理崩在半路。
 */
export function apiKeyFromCommand(provider, { timeoutMs = 5000 } = {}) {
  const auth = isPlainObject(provider?.auth) ? provider.auth : {};
  if (typeof auth.command !== 'string' || !auth.command.trim()) return Promise.resolve(null);
  if (auth.allowCommand === false) return Promise.resolve(null);

  // 按空白切成 argv：只支持「命令 + 参数」这种最朴素的形式，
  // 不做 shell 解析（引号、管道、重定向一概不认）——那才是安全面。
  const parts = auth.command.trim().split(/\s+/);
  const file = parts[0];
  const args = parts.slice(1);

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const value = String(stdout || '').trim();
        resolve(value || null);
      },
    );
  });
}

/**
 * 取 provider 的凭据值。按来源优先级挨个试：环境变量 → 命令。
 *
 * 返回 `{ value, source }`，source 只说明「从哪来」（给日志看），
 * **不含 key 本身**——调用方要自己装进请求头。
 */
export async function resolveApiKey(provider, { env = process.env, timeoutMs = 5000 } = {}) {
  const fromEnv = apiKeyFromEnv(provider, env);
  if (fromEnv) {
    const auth = isPlainObject(provider?.auth) ? provider.auth : {};
    // apiKeyFromEnv 取得到值 ⟹ 候选名列表非空 ⟹ 首个名字必然非空。
    // 所以这里不必再兜一个「没有名字」的分支——那是个走不到的死路。
    const name = String(auth.env || '').split(',').map((item) => item.trim()).filter(Boolean)[0];
    return { value: fromEnv, source: `env:${name}` };
  }
  const fromCommand = await apiKeyFromCommand(provider, { timeoutMs });
  if (fromCommand) return { value: fromCommand, source: 'command' };
  return null;
}

/**
 * 把 baseUrl 拆成连接信息。
 * baseUrl 形如 https://api.openai.com/v1 → protocol=https, host=api.openai.com, basePath=/v1
 */
export function parseProviderBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port,
      hostHeader: url.port ? `${url.hostname}:${url.port}` : url.hostname,
      basePath: url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '',
    };
  } catch {
    return null;
  }
}
