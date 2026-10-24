import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { t } from './messages.js';

/**
 * 按 URL 协议选 http / https 客户端。
 *
 * 官方端点全是 https，但自建 GitHub Enterprise 走 http——写死 https 会让那种部署直接连不上。
 * 端点可注入也是为了能对着本地 mock server 做测试。
 */
function requestFor(url, options) {
  return url.protocol === 'http:' ? http.request(options) : https.request(options);
}

/**
 * GitHub Copilot 凭据与 token 管理（v0.3.0）。
 *
 * 默认直接把 GitHub token 发给 Copilot API（与 OMP / Hermes 一致）：
 *
 *   GitHub token（gho_ / ghu_ / github_pat_）
 *     ↓  Authorization: Bearer <GitHub token>
 *   POST https://api.githubcopilot.com/{chat/completions | responses}
 *
 * 也保留旧的两级调用链，供需要短命 token 的部署选择（auth.tokenMode: "session"）：
 *
 *   GitHub token
 *     ↓  GET https://api.github.com/copilot_internal/v2/token
 *   session token（约 30 分钟过期）
 *     ↓  POST https://api.githubcopilot.com/{chat/completions | responses}
 *
 * 直连是默认值：GitHub 现在接受 gho_ / ghu_ / github_pat_ 直连，而
 * copilot_internal/v2/token 对 gh CLI 的 OAuth token 会返回 403。
 *
 * 凭据来源按 GitHub Copilot SDK 官方的优先级顺序取：
 *   COPILOT_GITHUB_TOKEN → GH_TOKEN → GITHUB_TOKEN → gh CLI → 设备流登录
 * 中间还插了一环「凭据文件」：它是上一次设备流登录的存档，
 * 排在 gh CLI **之后**——gh CLI 是活的登录态，比存档更该优先。
 * 除设备流外，其余都是**纯读取用户已有的官方登录态**，不需要额外授权。
 *
 * ⚠️ 官方 SDK 明确写着 `ghp_`（classic PAT）已弃用、不支持——
 * 要用 fine-grained PAT（`github_pat_`，带 Copilot Requests 权限）或 OAuth token。
 *
 * 安全约定（与本项目其余部分一致）：
 * - **凭据绝不进日志**。本模块只把「来源名」交给上层，值不外泄。
 * - 设备流登录后的 token 存在 ~/.lsp/ 下，权限 0600。
 * - session token 只在内存里缓存，不落盘。
 */

/** 读取凭据的环境变量，按官方优先级排序。 */
export const COPILOT_TOKEN_ENV = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** Copilot session token 的交换端点。 */
export const COPILOT_TOKEN_ENDPOINT = 'https://api.github.com/copilot_internal/v2/token';

/** Copilot 的模型网关端点。 */
export const COPILOT_API_BASE = 'https://api.githubcopilot.com';

/** 设备流程的端点（RFC 8628 OAuth 2.0 Device Authorization Grant）。 */
export const DEVICE_CODE_ENDPOINT = 'https://github.com/login/device/code';
export const DEVICE_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';

/** 过期前多久刷新。session token 约 30 分钟过期，留 5 分钟余量。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * GitHub token 的两种用法：
 *   direct   直接作为 Bearer 发给 api.githubcopilot.com（OMP / Hermes 的做法）
 *   session  先换一个约 30 分钟有效期的 session token（旧版做法）
 *
 * direct 是默认值：GitHub 现在接受 gho_ / ghu_ / github_pat_ 直连，
 * 而 copilot_internal/v2/token 对 gh CLI 的 OAuth token 会返回 403。
 */
export const COPILOT_TOKEN_MODES = ['direct', 'session'];
export const DEFAULT_COPILOT_TOKEN_MODE = 'direct';

/**
 * 直连 token 的缓存时间。
 *
 * GitHub token 本身长命，但凭据文件可能刚被 `--login-copilot` 改写；
 * 缓存 5 分钟既避免每条请求都去执行 gh CLI，也能较快感知凭据替换。
 */
const DIRECT_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 归一化 token 模式；未知值退回 fallback。 */
export function normalizeCopilotTokenMode(value, fallback = DEFAULT_COPILOT_TOKEN_MODE) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return COPILOT_TOKEN_MODES.includes(mode) ? mode : fallback;
}

/** 凭据文件在 LSP_HOME 下的位置。 */
export const COPILOT_CREDENTIAL_FILE = 'copilot-credentials.json';

/** 官方 Copilot 客户端的公开 client id（VS Code 扩展同一个）。 */
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * token 的「形态」判定。官方 SDK 支持三种：
 *   gho_        OAuth user access token
 *   ghu_        GitHub App user access token
 *   github_pat_ fine-grained personal access token
 * `ghp_`（classic）已被官方弃用，认出来就明说，别让人以为能work。
 */
export function classifyToken(token) {
  if (typeof token !== 'string' || !token) return { kind: 'none', supported: false };
  const value = token.trim();
  if (value.startsWith('ghp_')) return { kind: 'classic-pat', supported: false };
  if (value.startsWith('github_pat_')) return { kind: 'fine-grained-pat', supported: true };
  if (value.startsWith('ghu_')) return { kind: 'github-app-user', supported: true };
  if (value.startsWith('gho_')) return { kind: 'oauth-user', supported: true };
  if (value.startsWith('ghs_')) return { kind: 'actions', supported: true };
  return { kind: 'unknown', supported: true };
}

/** classic PAT 在发请求前就报清楚，别让上游回一个语焉不详的 401。 */
function assertSupportedToken(token) {
  if (classifyToken(token).kind === 'classic-pat') {
    throw new Error(t('copilot.err.classicPat'));
  }
}

/** 读取环境变量里的 GitHub token。 */
export function tokenFromEnv(env = process.env) {
  for (const name of COPILOT_TOKEN_ENV) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: `env:${name}`, envName: name };
    }
  }
  return null;
}

/** 凭据文件的位置。LSP_HOME 优先，否则 ~/.lsp。 */
export function credentialFilePath(env = process.env) {
  const home = typeof env.LSP_HOME === 'string' && env.LSP_HOME.trim() ? env.LSP_HOME.trim() : path.join(os.homedir(), '.lsp');
  return path.join(path.resolve(home), COPILOT_CREDENTIAL_FILE);
}

/** 读凭据文件。文件不存在或坏了都返回 null，不抛错。 */
export function readStoredCredential(env = process.env) {
  try {
    const file = credentialFilePath(env);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) return null;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    if (!token) return null;
    return { token, source: 'file', envName: null };
  } catch {
    return null;
  }
}

/** 写凭据文件，权限 0600。 */
export function writeStoredCredential(token, env = process.env) {
  const file = credentialFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位，忽略 */
  }
  return file;
}

/** 删凭据文件。 */
export function clearStoredCredential(env = process.env) {
  try {
    const file = credentialFilePath(env);
    // 文件本来就不存在时返回 false —— 调用方（登出流程）要靠它区分
    // 「已登出」与「本来就没登入」，一律返回 true 是在撒谎。
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 gh CLI 取 token。官方 Copilot CLI 也是这么兜底的
 * （"If you have GitHub CLI installed and authenticated, Copilot CLI can use its token"）。
 *
 * 用 execFile 而不是 exec：参数不经过 shell，token 不会出现在命令行里。
 */
export function tokenFromGhCli(command = 'gh', { timeoutMs = 5000, args = ['auth', 'token'] } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return resolve(null);
        const token = String(stdout || '').trim();
        if (!token) return resolve(null);
        resolve({ token, source: 'command:gh', envName: null });
      },
    );
  });
}

/**
 * 从任意命令取 token。命令字符串按空白切成 argv，**不经 shell**。
 * stdout 就是 token；命令失败或输出为空一律当作「没拿到」。
 */
export function tokenFromCommand(command, { timeoutMs = 5000 } = {}) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      parts[0],
      parts.slice(1),
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return resolve(null);
        const token = String(stdout || '').trim();
        if (!token) return resolve(null);
        resolve({ token, source: 'command', envName: null });
      },
    );
  });
}

/**
 * 找出可用的 GitHub token。按官方优先级：
 *   provider 点名的变量 → 官方环境变量链 → gh CLI → 凭据文件 → 设备流登录
 *
 * 返回的对象里带着 token 本身——调用方只在需要时用它换 session token，不要外传。
 *
 * @param {object} options
 * @param {object} [options.env]         环境变量
 * @param {boolean} [options.allowCommand] 是否允许执行命令
 * @param {string}  [options.command]     自定义取 token 的命令（优先于 gh CLI）
 * @param {string[]} [options.envNames]   provider 指定的额外环境变量（优先于官方链）
 * @param {boolean} [options.allowDeviceFlow] 是否允许设备流登录（需要用户交互，默认关）
 * @param {Function} [options.onDeviceCode] 设备码回调：把 user_code 与验证地址交给上层显示
 */
export async function resolveGitHubToken({
  env = process.env,
  allowCommand = true,
  command = null,
  envNames = [],
  allowDeviceFlow = false,
  onDeviceCode = null,
} = {}) {
  // provider 明确指定的变量优先——用户点名了，就该先听他的
  for (const name of (Array.isArray(envNames) ? envNames : [])) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return { token: value.trim(), source: `env:${name.trim()}`, envName: name.trim() };
    }
  }

  const fromEnv = tokenFromEnv(env);
  if (fromEnv) return fromEnv;

  // gh CLI 在凭据文件之前：它是活的登录态，优先于上一次设备流留下的存档
  if (allowCommand) {
    const fromCmd = command
      ? await tokenFromCommand(command)
      : await tokenFromGhCli();
    if (fromCmd) return fromCmd;
  }

  const stored = readStoredCredential(env);
  if (stored) return stored;

  // 设备流是最后一环，而且是唯一需要人参与的：默认不启用，
  // 只有 provider 明确写了 auth.deviceFlow 才走。
  if (allowDeviceFlow) {
    return runDeviceFlow({ env, onDeviceCode });
  }

  return null;
}

/**
 * 设备流登录：拿 device code → 让用户在浏览器里授权 → 轮询换 token → 存档。
 *
 * 拿到的 token 落进凭据文件（0600），下次直接读文件，不必再问用户一遍。
 *
 * 两步网络调用都做成可注入的：单测要能验证编排与存档，不该真的去点 GitHub。
 */
export async function runDeviceFlow({
  env = process.env,
  onDeviceCode = null,
  timeoutMs = 900000,
  intervalMs = 5000,
  requestDevice = requestDeviceCode,
  pollDevice = pollDeviceToken,
} = {}) {
  const device = await requestDevice();
  const userCode = device.user_code || device.userCode || '';
  const verificationUri = device.verification_uri || device.verificationUri || '';
  if (onDeviceCode) {
    onDeviceCode({ userCode, verificationUri, expiresIn: device.expires_in ?? null });
  }
  const result = await pollDevice(device.device_code, { intervalMs, timeoutMs });
  const token = result.token;
  let stored = false;
  try {
    writeStoredCredential(token, env);
    stored = true;
  } catch {
    // 存档失败不影响这一次登录——token 已经在手里了，只是下次要再登录一次。
    // 但调用方（--login-copilot）要靠 stored 如实报告是否真的存下来了。
  }
  return { token, source: 'device-flow', envName: null, stored };
}

/** 用 GitHub token 换 Copilot session token。 */
export function exchangeSessionToken(githubToken, { timeoutMs = 15000, endpoint = COPILOT_TOKEN_ENDPOINT } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const request = requestFor(url, {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'llm-session-proxy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: timeoutMs,
    });
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(t('copilot.err.tokenExchangeFailed', { status: response.statusCode })));
          return;
        }
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          reject(new Error(t('copilot.err.tokenNotJson')));
          return;
        }
        const token = parsed?.token;
        if (typeof token !== 'string' || !token) {
          reject(new Error(t('copilot.err.tokenMissing')));
          return;
        }
        // expires_at 是 Unix 秒；缺失时按 30 分钟估
        const expiresAt = Number.isFinite(parsed?.expires_at)
          ? Number(parsed.expires_at) * 1000
          : Date.now() + 30 * 60 * 1000;
        resolve({ token, expiresAt });
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error(t('copilot.err.tokenTimeout')));
    });
    request.on('error', (error) => reject(error));
    request.end();
  });
}

/**
 * Copilot token 管理器：内存缓存 + 到期前自动刷新。
 *
 * 两种模式（见 COPILOT_TOKEN_MODES）：
 *   direct   缓存 GitHub token 本身，直接发给 Copilot API
 *   session  缓存交换出来的 session token（约 30 分钟）
 *
 * 刻意不落盘：session token 有效期只有半小时，落盘收益极小而泄露面明显变大。
 * 长期凭据（GitHub token）落盘，短的这一级不落。
 *
 * 缓存按「凭据来源 + 模式」分桶：不同的 provider 可能用不同的环境变量或命令取
 * GitHub token，混在一份缓存里会让 A 的 token 被发给 B；两种模式的 token 形态
 * 也不同，不能共用一条缓存。
 */
export function createCopilotSessionManager({
  env = process.env,
  allowCommand = true,
  command = null,
  tokenMode = DEFAULT_COPILOT_TOKEN_MODE,
  directTtlMs = DIRECT_TOKEN_TTL_MS,
  now = () => Date.now(),
  // 换 session token 的那一步做成可注入的：单测要能验证缓存与刷新逻辑，
  // 而不该真的去打 api.github.com。
  exchangeSession = exchangeSessionToken,
} = {}) {
  // key -> { token, expiresAt, source, mode }
  const cache = new Map();
  // key -> Promise（并发去重）
  const pending = new Map();

  const isFresh = (entry) => {
    if (!entry?.token) return false;
    const expiresAt = entry.expiresAt || 0;
    // session token 提前 5 分钟刷新；direct 的过期时间是我们自己的缓存 TTL，
    // 不能套用这个余量，否则 5 分钟 TTL 会永远被判成「快过期」。
    const margin = entry.mode === 'session' ? REFRESH_MARGIN_MS : 0;
    return expiresAt - margin > now();
  };

  /** 把凭据来源与模式压成一个稳定的缓存键。 */
  const cacheKey = (options = {}) => {
    const envNames = Array.isArray(options.envNames) ? options.envNames.join(',') : '';
    const cmd = typeof options.command === 'string' ? options.command : '';
    const allow = options.allowCommand === false ? '0' : '1';
    const device = options.allowDeviceFlow ? '1' : '0';
    const mode = normalizeCopilotTokenMode(options.tokenMode, tokenMode);
    return `${envNames}|${cmd}|${allow}|${device}|${mode}`;
  };

  /** 拿一个可用的 Copilot token，必要时刷新。 */
  const get = async (options = {}) => {
    const mode = normalizeCopilotTokenMode(options.tokenMode, tokenMode);
    const key = cacheKey({ ...options, tokenMode: mode });
    const cached = cache.get(key);
    if (isFresh(cached)) return cached;
    // 并发请求同时触发时只换一次
    if (pending.has(key)) return pending.get(key);

    const promise = (async () => {
      try {
        const github = await resolveGitHubToken({
          env,
          allowCommand: options.allowCommand !== false && allowCommand,
          command: options.command ?? command,
          envNames: options.envNames || [],
          allowDeviceFlow: options.allowDeviceFlow === true,
          onDeviceCode: options.onDeviceCode || null,
        });
        if (!github) {
          throw new Error(t('copilot.err.noGitHubToken', { envs: COPILOT_TOKEN_ENV.join(' | ') }));
        }
        assertSupportedToken(github.token);
        let entry;
        if (mode === 'session') {
          const session = await exchangeSession(github.token);
          entry = { token: session.token, expiresAt: session.expiresAt, source: github.source, mode };
        } else {
          entry = { token: github.token, expiresAt: now() + directTtlMs, source: github.source, mode };
        }
        cache.set(key, entry);
        // 只记来源名，不记 token 本身
        return entry;
      } finally {
        pending.delete(key);
      }
    })();

    pending.set(key, promise);
    return promise;
  };

  return {
    get,
    /** 当前缓存是否可用（doctor 用，不触发网络）。 */
    peek: (options = {}) => {
      const entry = cache.get(cacheKey(options));
      return isFresh(entry) ? { ...entry } : null;
    },
    invalidate: (options = {}) => {
      if (options === undefined) {
        cache.clear();
        return;
      }
      cache.delete(cacheKey(options));
    },
  };
}

/**
 * 设备流程登录：GitHub 的 OAuth 2.0 Device Authorization Grant（RFC 8628）。
 *
 * 步骤与官方文档一致：
 *   1. POST /login/device/code      → device_code + user_code + verification_uri
 *   2. 用户在浏览器输入 user_code   → 授权
 *   3. POST /login/oauth/access_token（grant_type=urn:ietf:params:oauth:grant-type:device_code）→ access_token
 *
 * 官方 Copilot SDK 也是用这套（"Users authenticate via GitHub OAuth device flow"）。
 */
export function requestDeviceCode({
  clientId = COPILOT_CLIENT_ID,
  scope = 'read:user',
  timeoutMs = 15000,
  endpoint = DEVICE_CODE_ENDPOINT,
} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const payload = JSON.stringify({ client_id: clientId, scope });
    const request = requestFor(url, {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'llm-session-proxy' },
      timeout: timeoutMs,
    });
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(t('copilot.err.deviceCodeFailed', { status: response.statusCode })));
          return;
        }
        try {
          const parsed = JSON.parse(text);
          if (!parsed?.device_code) {
            reject(new Error(t('copilot.err.deviceCodeMissing')));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new Error(t('copilot.err.deviceCodeNotJson')));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(t('copilot.err.tokenTimeout'))));
    request.on('error', (error) => reject(error));
    request.write(payload);
    request.end();
  });
}

/** 轮询设备流程的授权结果。 */
export function pollDeviceToken(
  deviceCode,
  {
    clientId = COPILOT_CLIENT_ID,
    intervalMs = 5000,
    timeoutMs = 900000,
    now = () => Date.now(),
    endpoint = DEVICE_TOKEN_ENDPOINT,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const deadline = now() + timeoutMs;
    let wait = intervalMs;

    const attempt = () => {
      if (now() > deadline) {
        reject(new Error(t('copilot.err.deviceTimeout')));
        return;
      }
      const url = new URL(endpoint);
      const payload = JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      const request = requestFor(url, {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'llm-session-proxy' },
      });
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(new Error(t('copilot.err.deviceTokenNotJson')));
            return;
          }
          if (response.statusCode === 200 && parsed?.access_token) {
            resolve({ token: String(parsed.access_token), scope: parsed.scope || '' });
            return;
          }
          const error = parsed?.error || 'unknown';
          if (error === 'authorization_pending') {
            setTimeout(attempt, wait);
            return;
          }
          if (error === 'slow_down') {
            wait += 5000;
            setTimeout(attempt, wait);
            return;
          }
          reject(new Error(t('copilot.err.deviceFailed', { error })));
        });
      });
      request.on('error', (error) => reject(error));
      request.write(payload);
      request.end();
    };

    attempt();
  });
}
