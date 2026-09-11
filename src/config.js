import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LEVELS, ROTATE_MODES } from './logger.js';
import { SUPPORTED_LANGS, normalizeLang, setLang, t } from './messages.js';

/** 默认日志文件基名（与包名一致），用于拼默认路径与归档匹配。 */
export const LOG_BASENAME = 'llm-session-proxy';
/** 默认配置目录名（家目录下的隐藏目录），可用 LSP_HOME 覆盖。 */
export const DEFAULT_HOME_DIR = '.lsp';

/**
 * 默认配置。
 *
 * 默认值刻意对齐 OpenCode Go / Zen 的要求（注入 x-opencode-* 会话头），
 * 但每一项都可以被配置文件、环境变量或命令行参数覆盖，以适配任意上游。
 */
export const DEFAULT_CONFIG = {
  listen: {
    host: '127.0.0.1',
    port: 9355,
  },
  upstream: {
    protocol: 'https',
    host: 'opencode.ai',
    port: null,
    basePath: '',
    rewriteHost: true,
  },
  request: {
    bufferBody: true,
    maxBodyBytes: 64 * 1024 * 1024,
    timeoutMs: 600000,
    pathRewrite: [],
    dropHeaders: [],
    forwardClientSessionHeaders: true,
  },
  session: {
    enabled: true,
    headerNames: [
      'x-opencode-session',
      'x-session-id',
      'x-conversation-id',
      'x-thread-id',
      'x-chat-id',
    ],
    bodyFields: [
      'session_id',
      'sessionId',
      'conversation_id',
      'conversationId',
      'thread_id',
      'threadId',
      'chat_id',
      'chatId',
    ],
    contentHash: {
      enabled: true,
      fields: ['system', 'system_instruction', 'instructions'],
      includeFirstUserMessage: true,
      includePromptField: true,
    },
    idPrefix: 'ses_',
    idFormat: 'hex26',
    requestIdFormat: 'msg_{{session.count}}',
    maxSessions: 512,
    ttlSeconds: 0,
  },
  inject: {
    headers: {
      'x-opencode-session': '{{session.id}}',
      'x-opencode-request': '{{session.requestId}}',
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
    },
    body: {},
    removeBodyFields: [],
    overwrite: true,
  },
  model: {
    enabled: true,
    field: 'model',
    stripPrefixes: ['proxy-'],
    map: {},
    default: null,
  },
  userAgent: 'opencode/1.18.29 cli',
  // keep：完全保留客户端 UA；replace：始终用上面的 UA；
  // replace-generic：仅当客户端 UA 缺失或像个通用 HTTP 库时才替换（默认）
  userAgentMode: 'replace-generic',
  // 控制台与日志文案语言。默认英文，需要中文显式切换（--lang zh / PROXY_LANG=zh）。
  lang: 'en',
  response: {
    stream: true,
    timeoutMs: 600000,
  },
  log: {
    level: 'info',
    // null  → 默认位置（$LSP_HOME/logs 或 ~/.lsp/logs）下的 <LOG_BASENAME>.log
    // string → 指定文件；false → 不写文件，只输出到控制台
    file: null,
    // 只想改目录、文件名保持默认时用它
    dir: null,
    // size | daily | off
    rotate: 'size',
    maxBytes: 5 * 1024 * 1024,
    backups: 2,
    // 超过这个天数的历史日志自动删除；0 表示永久保留
    keepDays: 30,
    requests: true,
  },
};

const GENERIC_UA_RE = /^(node|undici|axios|node-fetch|python-requests|python-httpx|go-http-client|java|okhttp|curl|postmanruntime|got|superagent|request|apache-httpclient|libwww-perl|http\.client|wget)/i;

const ENV_MAP = {
  PROXY_HOST: ['listen', 'host'],
  PROXY_PORT: ['listen', 'port'],
  UPSTREAM_PROTO: ['upstream', 'protocol'],
  UPSTREAM_HOST: ['upstream', 'host'],
  UPSTREAM_PORT: ['upstream', 'port'],
  UPSTREAM_BASE_PATH: ['upstream', 'basePath'],
  OPENCODE_UA: ['userAgent'],
  USER_AGENT: ['userAgent'],
  USER_AGENT_MODE: ['userAgentMode'],
  // 刻意不读 POSIX 的 LANG：那是系统区域设置，不代表本工具的文案语言偏好。
  PROXY_LANG: ['lang'],
  LOG_FILE: ['log', 'file'],
  LOG_LEVEL: ['log', 'level'],
  LOG_DIR: ['log', 'dir'],
  LOG_ROTATE: ['log', 'rotate'],
  LOG_KEEP_DAYS: ['log', 'keepDays'],
  LOG_MAX_BYTES: ['log', 'maxBytes'],
  LOG_BACKUPS: ['log', 'backups'],
  SESSION_ID_PREFIX: ['session', 'idPrefix'],
  SESSION_ID_FORMAT: ['session', 'idFormat'],
  REQUEST_ID_FORMAT: ['session', 'requestIdFormat'],
  MAX_SESSIONS: ['session', 'maxSessions'],
  SESSION_TTL: ['session', 'ttlSeconds'],
  MODEL_ALIAS_PREFIX: ['model', 'stripPrefixes'],
  INJECT_HEADERS: ['inject', 'headers'],
  PATH_REWRITE: ['request', 'pathRewrite'],
  TIMEOUT_MS: ['request', 'timeoutMs'],
  MAX_BODY_BYTES: ['request', 'maxBodyBytes'],
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 递归合并：普通对象逐层合并，数组与其他类型整体覆盖。 */
export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? [...base] : { ...(isPlainObject(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** 宽松 JSON：允许 // 与 /* *​/ 注释、允许尾随逗号。方便写带说明的配置文件。 */
export function parseJsonLoose(text, source = '<inline>') {
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, (match) =>
      match.startsWith('"') ? match : '',
    )
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw new Error(t('config.parseFailed', { source, message: error.message }));
  }
}

export function loadConfigFile(filePath) {
  const resolved = path.resolve(filePath);
  const text = fs.readFileSync(resolved, 'utf8');
  const raw = parseJsonLoose(text, resolved);
  if (!isPlainObject(raw)) throw new Error(t('config.rootNotObject', { path: resolved }));
  return { config: raw, path: resolved };
}

/** 把上游 URL / host:port 字符串解析成 upstream 片段。 */
export function parseUpstream(input) {
  if (!input) return {};
  const text = String(input).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  const url = new URL(withScheme);
  const basePath = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : '';
  return {
    protocol: url.protocol.replace(':', ''),
    host: url.hostname,
    port: url.port ? Number(url.port) : null,
    basePath,
  };
}

function setByPath(target, keyPath, value) {
  let cursor = target;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keyPath[keyPath.length - 1]] = value;
}

function coerce(keyPath, raw) {
  const key = keyPath.join('.');
  if (/^(listen\.port|upstream\.port|request\.timeoutMs|request\.maxBodyBytes|session\.maxSessions|session\.ttlSeconds|response\.timeoutMs|log\.maxBytes|log\.backups|log\.keepDays)$/.test(key)) {
    const num = Number(raw);
    if (!Number.isFinite(num)) throw new Error(t('config.envNotNumber', { key, raw }));
    return num;
  }
  if (key === 'log.file' && /^(off|none|false|no|0)$/i.test(String(raw).trim())) {
    // LOG_FILE=off 关闭文件输出（命令行对应 --no-log-file）
    return false;
  }
  if (key === 'log.rotate') return String(raw).trim().toLowerCase();
  if (/^(inject\.headers|request\.pathRewrite)$/.test(key)) {
    const value = JSON.parse(raw);
    return value;
  }
  if (key === 'model.stripPrefixes') {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw;
}

/** 从环境变量读取配置片段。 */
export function configFromEnv(env = process.env) {
  const out = {};
  for (const [envName, keyPath] of Object.entries(ENV_MAP)) {
    const raw = env[envName];
    if (raw === undefined || raw === '') continue;
    setByPath(out, keyPath, coerce(keyPath, raw));
  }
  if (env.CONFIG_FILE) out.__configFile = env.CONFIG_FILE;
  return out;
}

function normalize(config) {
  const next = { ...config };
  if (typeof next.upstream?.host === 'string' && /:\/\//.test(next.upstream.host)) {
    next.upstream = deepMerge(next.upstream, parseUpstream(next.upstream.host));
  }
  next.listen.port = Number(next.listen.port);
  // zh-CN / zh-Hans / en-US 之类的写法先归一化；识别不了的原样保留，由 validate 统一报错
  if (next.lang !== undefined && next.lang !== null) {
    next.lang = normalizeLang(next.lang) || next.lang;
  }
  if (next.upstream.port !== null && next.upstream.port !== undefined) {
    next.upstream.port = Number(next.upstream.port);
  }
  if (next.model && Array.isArray(next.model.stripPrefixes)) {
    next.model.stripPrefixes = next.model.stripPrefixes.filter((p) => typeof p === 'string' && p.length > 0);
  }
  if (isPlainObject(next.log)) {
    const log = { ...next.log };
    // 空串等同于"没写"，退回默认位置而不是当成当前目录
    if (typeof log.file === 'string' && !log.file.trim()) log.file = null;
    if (typeof log.dir === 'string' && !log.dir.trim()) log.dir = null;
    if (typeof log.rotate === 'string') log.rotate = log.rotate.trim().toLowerCase();
    for (const key of ['maxBytes', 'backups', 'keepDays']) {
      if (log[key] !== undefined && log[key] !== null) log[key] = Number(log[key]);
    }
    next.log = log;
  }
  if (next.request && Array.isArray(next.request.pathRewrite)) {
    next.request.pathRewrite = next.request.pathRewrite
      .map((rule) => {
        if (!rule || typeof rule !== 'object') return null;
        const pattern = rule.pattern ?? rule.from;
        const replacement = rule.replacement ?? rule.to ?? '';
        if (typeof pattern !== 'string') return null;
        try {
          // 提前编译，配置错误在启动时就暴露
          // eslint-disable-next-line no-new
          new RegExp(pattern);
        } catch (error) {
          throw new Error(t('config.badRegex', { pattern, message: error.message }));
        }
        return { pattern, replacement, flags: rule.flags || undefined };
      })
      .filter(Boolean);
  }
  return next;
}

function validate(config) {
  const errors = [];
  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) {
    errors.push(t('config.badPort', { port: config.listen.port }));
  }
  if (!config.upstream?.host) errors.push(t('config.emptyHost'));
  if (!['http', 'https'].includes(config.upstream?.protocol)) {
    errors.push(t('config.badProtocol', { protocol: config.upstream?.protocol }));
  }
  if (config.session?.enabled && !['hex26', 'hex', 'uuid', 'base36', 'short'].includes(config.session.idFormat)) {
    errors.push(t('config.badIdFormat', { format: config.session.idFormat }));
  }
  if (config.inject?.headers && !isPlainObject(config.inject.headers)) {
    errors.push(t('config.injectNotObject'));
  }
  if (!SUPPORTED_LANGS.includes(config.lang)) {
    errors.push(t('config.badLang', { lang: config.lang }));
  }
  validateLog(config.log, errors);
  if (errors.length) throw new Error(t('config.validationFailed', { list: errors.join('\n  - ') }));
  return config;
}

/** 日志配置的校验：宁可启动即报错，也不要静默退化成"不写日志"。 */
function validateLog(log, errors) {
  if (!isPlainObject(log)) {
    errors.push(t('config.badLog'));
    return;
  }
  const fileOk =
    log.file === null ||
    log.file === false ||
    (typeof log.file === 'string' && log.file.trim().length > 0);
  if (!fileOk) errors.push(t('config.badLogFile', { file: JSON.stringify(log.file) }));
  if (log.dir !== null && (typeof log.dir !== 'string' || !log.dir.trim())) {
    errors.push(t('config.badLogDir', { dir: JSON.stringify(log.dir) }));
  }
  if (!ROTATE_MODES.includes(log.rotate)) {
    errors.push(t('config.badLogRotate', { rotate: log.rotate, modes: ROTATE_MODES.join(' | ') }));
  }
  if (!Object.hasOwn(LEVELS, log.level)) {
    errors.push(t('config.badLogLevel', { level: log.level, levels: Object.keys(LEVELS).join(' | ') }));
  }
  for (const key of ['maxBytes', 'backups', 'keepDays']) {
    const value = log[key];
    if (!Number.isFinite(value) || value < 0) {
      errors.push(t('config.badLogNumber', { key: `log.${key}`, value }));
    }
  }
}

export function resolveLogFile(log = {}, { env = process.env, name = LOG_BASENAME } = {}) {
  if (log.file === false) return null;
  if (typeof log.file === 'string' && log.file.trim()) return path.resolve(log.file.trim());
  const dir =
    typeof log.dir === 'string' && log.dir.trim() ? path.resolve(log.dir.trim()) : defaultLogDir(env);
  return path.join(dir, `${name}.log`);
}

/** 默认日志目录：LSP_HOME/logs（设置了的话），否则 ~/.lsp/logs。 */
export function defaultLogDir(env = process.env) {
  const home = typeof env.LSP_HOME === 'string' ? env.LSP_HOME.trim() : '';
  if (home) return path.resolve(home, 'logs');
  return path.join(os.homedir(), DEFAULT_HOME_DIR, 'logs');
}

/**
 * 组装最终配置：默认值 < 配置文件 < 环境变量 < 命令行参数。
 * 三者都是同一套字段，优先级从低到高。
 */
export function buildConfig({ file = null, env = process.env, flags = {} } = {}) {
  let merged = deepMerge(DEFAULT_CONFIG, {});
  let configPath = file || env.CONFIG_FILE || null;

  if (configPath) {
    const loaded = loadConfigFile(configPath);
    merged = deepMerge(merged, loaded.config);
    configPath = loaded.path;
  }

  const fromEnv = configFromEnv(env);
  delete fromEnv.__configFile;
  merged = deepMerge(merged, fromEnv);
  merged = deepMerge(merged, flags);

  // 语言在四层合并全部完成、校验之前生效，这样后续的校验报错也是同一个语言。
  if (typeof merged.lang === 'string') setLang(merged.lang);

  const normalized = normalize(merged);
  validate(normalized);
  normalized.__configPath = configPath;
  return normalized;
}

/** 上游连接信息，供代理层使用。 */
export function resolveUpstream(config) {
  const { protocol, host, port, basePath } = config.upstream;
  const defaultPort = protocol === 'https' ? 443 : 80;
  return {
    protocol,
    host,
    port: port ?? defaultPort,
    hostHeader: (port ?? defaultPort) === defaultPort ? host : `${host}:${port ?? defaultPort}`,
    basePath: basePath || '',
  };
}

export function shouldReplaceUserAgent(incoming, config) {
  const mode = config.userAgentMode || 'replace-generic';
  if (mode === 'keep') return false;
  if (mode === 'replace') return true;
  if (!incoming) return true;
  return GENERIC_UA_RE.test(String(incoming).trim()) || String(incoming).toLowerCase().includes('opencode');
}
