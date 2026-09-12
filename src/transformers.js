import { t } from './messages.js';

/**
 * 命名变换注册表（transformer registry）。
 *
 * 一个「变换」就是对请求体的一个纯函数式改动：进 body，出 { changed, changes }。
 * 它们由 router 分桶按名字挂载，名字写在配置里，因此不需要加载任何外部代码
 * —— **刻意不支持从任意路径 require 插件**：那会让「零依赖 + 只听回环」的
 * 安全面瞬间失效。要加新变换就在本文件里加一条，这是有意的取舍。
 *
 * 每个变换声明 phase：`request` 现在就会执行；`response`（SSE 转码用）预留给
 * v0.2.2 的协议互转，注册表先把位置留出来，避免那时再改一次结构。
 *
 * 变换必须**原地改**传进来的 body（调用方持同一引用），并如实回报改了什么，
 * 日志只记 changes 摘要，不打印整个请求体。
 */

/** 请求相位：在 body 上就地生效。 */
export const REQUEST_PHASE = 'request';
/** 响应相位：留给 v0.2.2 的协议互转。 */
export const RESPONSE_PHASE = 'response';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getByPath(target, keyPath) {
  let cursor = target;
  for (const segment of String(keyPath).split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function deleteByPath(target, keyPath) {
  const segments = String(keyPath).split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = cursor?.[segments[i]];
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return false;
  }
  if (!cursor || typeof cursor !== 'object') return false;
  const last = segments[segments.length - 1];
  if (!Object.hasOwn(cursor, last)) return false;
  delete cursor[last];
  return true;
}

/** 把 ["a.b"] 这类点路径写进对象，空路径忽略。 */
function setByPath(target, keyPath, value) {
  const segments = String(keyPath).split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[segments[segments.length - 1]] = value;
}

/** 值为空的判定：null / 空串 / 空数组 / 空对象都算空。 */
function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * 注意：这里的每一个 apply 都必须能被安全地重复调用（幂等或至少不炸），
 * 因为 --dry-run 会用样例 body 跑一遍同样的代码路径。
 */
const REGISTRY = {
  noop: {
    phase: REQUEST_PHASE,
    describe: () => t('transformer.noop'),
    apply() {
      return { changed: false, changes: [] };
    },
  },

  'drop-fields': {
    phase: REQUEST_PHASE,
    describe: () => t('transformer.dropFields'),
    apply(body, { options = {} } = {}) {
      const changes = [];
      for (const field of options.fields || []) {
        if (typeof field === 'string' && field && deleteByPath(body, field)) {
          changes.push(`-${field}`);
        }
      }
      return { changed: changes.length > 0, changes };
    },
  },

  'drop-empty-fields': {
    phase: REQUEST_PHASE,
    describe: () => t('transformer.dropEmptyFields'),
    apply(body, { options = {} } = {}) {
      const changes = [];
      const targets = options.fields?.length ? options.fields : Object.keys(body);
      for (const field of targets) {
        if (typeof field !== 'string' || !field) continue;
        if (isEmptyValue(getByPath(body, field)) && deleteByPath(body, field)) {
          changes.push(`-${field}`);
        }
      }
      return { changed: changes.length > 0, changes };
    },
  },

  'rename-fields': {
    phase: REQUEST_PHASE,
    describe: () => t('transformer.renameFields'),
    apply(body, { options = {} } = {}) {
      const changes = [];
      for (const [from, to] of Object.entries(options.map || {})) {
        if (typeof to !== 'string' || !to || from === to) continue;
        const value = getByPath(body, from);
        if (value === undefined) continue;
        deleteByPath(body, from);
        setByPath(body, to, value);
        changes.push(`${from}->${to}`);
      }
      return { changed: changes.length > 0, changes };
    },
  },

  'clamp-max-tokens': {
    phase: REQUEST_PHASE,
    describe: () => t('transformer.clampMaxTokens'),
    apply(body, { options = {} } = {}) {
      const max = Number(options.max);
      if (!Number.isFinite(max) || max <= 0) return { changed: false, changes: [] };
      const changes = [];
      for (const field of options.fields || ['max_tokens', 'max_completion_tokens']) {
        const value = getByPath(body, field);
        if (typeof value === 'number' && value > max) {
          setByPath(body, field, max);
          changes.push(`${field}:${value}->${max}`);
        }
      }
      return { changed: changes.length > 0, changes };
    },
  },
};

/** 注册表里所有变换名（保持定义顺序，便于 doctor 稳定输出）。 */
export function listTransformers() {
  return Object.keys(REGISTRY);
}

/** 按名字取一条变换定义，未注册返回 null。 */
export function getTransformer(name) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name) ? REGISTRY[name] : null;
}

/** 名字是否已注册。配置校验用它，避免把拼写错误留到运行时。 */
export function isTransformer(name) {
  return getTransformer(name) !== null;
}

/** 描述表，供 doctor 与文档复用（随语言变化，所以是函数）。 */
export function describeTransformers() {
  return listTransformers().map((name) => ({
    name,
    phase: REGISTRY[name].phase,
    description: REGISTRY[name].describe(),
  }));
}

/**
 * 按顺序执行一串命名变换。
 *
 * 未注册的名字不抛错也不静默：跳过并记进 `skipped`，由上层决定是否告警
 * ——配置校验其实已经在启动时拦掉了，这里只是防御。
 */
export function applyTransformers(body, names = [], { options = {} } = {}) {
  const applied = [];
  const skipped = [];
  const changes = [];

  if (!isPlainObject(body)) return { changed: false, applied, skipped, changes };

  for (const name of names) {
    const transformer = getTransformer(name);
    if (!transformer) {
      skipped.push(name);
      continue;
    }
    if (transformer.phase !== REQUEST_PHASE) {
      // 响应相位的变换现在无处安放，明确跳过而不是假装执行过
      skipped.push(name);
      continue;
    }
    const result = transformer.apply(body, { options: options[name] || {} }) || {};
    applied.push(name);
    if (Array.isArray(result.changes)) changes.push(...result.changes.map((c) => `${name}:${c}`));
  }

  return { changed: changes.length > 0, applied, skipped, changes };
}
