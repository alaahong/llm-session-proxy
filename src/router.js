import { t } from './messages.js';

/**
 * 路由分桶（router buckets）。
 *
 * 一个「桶」是两条决定的组合：**换成哪个模型**、**挂哪些变换**。
 * 这正好对上 claude-code-router 的思路——按请求的性质分流，而不是把所有请求
 * 都塞给同一个模型、同一套参数。
 *
 * 三个刻意的设计取舍：
 *
 * 1. **判定用字节数，不用 token 数。** 估 token 要引分词器，既违背零依赖，
 *    又会给出一个不准的数字；请求体字节数是确定量，阈值调起来反而踏实。
 * 2. **规则自上而下，首个命中生效**，同一条规则里的多个条件是 AND。
 *    想看"为什么落到了这个桶"，把规则按从具体到宽泛排，再跑 --dry-run。
 * 3. **模型名两条都试**：`modelPrefix` 同时匹配客户端原始名与解析后的真实
 *    ID，因为用户写规则时心里想的可能是 `proxy-think`，也可能是 `glm-5.3`。
 *
 * 本模块是纯函数，不碰网络、不打日志，便于单测与 doctor 复用。
 */

/** 内置的四个桶名。配置里可以只用其中一部分。 */
export const BUILTIN_BUCKETS = ['default', 'background', 'think', 'longContext'];

/** 规则里允许出现的匹配条件键。 */
export const RULE_MATCHERS = ['path', 'modelPrefix', 'bodyField', 'minBytes', 'maxBytes'];

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

/** 桶的默认形态：不换模型、不挂变换。 */
export function emptyBucket() {
  return { model: null, transformers: [] };
}

/**
 * 规则归一化：丢掉空条件、统一键名。
 * 返回 null 表示这条规则没有可用条件（校验阶段会报错，这里只负责过滤）。
 */
export function normalizeRule(rule) {
  if (!isPlainObject(rule) || typeof rule.bucket !== 'string' || !rule.bucket) return null;
  const out = { bucket: rule.bucket };
  if (typeof rule.path === 'string' && rule.path) out.path = rule.path;
  if (typeof rule.modelPrefix === 'string' && rule.modelPrefix) out.modelPrefix = rule.modelPrefix;
  if (typeof rule.bodyField === 'string' && rule.bodyField) {
    out.bodyField = rule.bodyField;
    if (rule.bodyFieldValue !== undefined) out.bodyFieldValue = rule.bodyFieldValue;
  }
  for (const key of ['minBytes', 'maxBytes']) {
    if (rule[key] !== undefined && rule[key] !== null) {
      const num = Number(rule[key]);
      if (Number.isFinite(num)) out[key] = num;
    }
  }
  out.reason = typeof rule.reason === 'string' && rule.reason.trim() ? rule.reason.trim() : null;
  return out;
}

/** 一条规则是否至少有一个匹配条件（只有 bucket 不算）。 */
export function hasMatcher(rule) {
  return RULE_MATCHERS.some((key) => rule?.[key] !== undefined);
}

/**
 * 判定单个条件是否命中。返回 null 表示"这个条件不参与判定"。
 * 判定所需的信息全部来自 request，函数本身无副作用。
 */
function matchPath(request, rule) {
  if (rule.path === undefined) return null;
  const path = typeof request.path === 'string' ? request.path : '';
  return path.startsWith(rule.path);
}

function matchModelPrefix(request, rule) {
  if (rule.modelPrefix === undefined) return null;
  const candidates = [request.clientModel, request.resolvedModel].filter(
    (value) => typeof value === 'string' && value,
  );
  if (!candidates.length) return false;
  return candidates.some((value) => value.startsWith(rule.modelPrefix));
}

function matchBodyField(request, rule) {
  if (rule.bodyField === undefined) return null;
  const value = getByPath(request.body, rule.bodyField);
  if (rule.bodyFieldValue !== undefined) return value === rule.bodyFieldValue;
  // 不给目标值时只要求"存在且不是空值"，这样 `{ bodyField: 'thinking' }` 就够用
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

function matchBytes(request, rule) {
  const size = Number.isFinite(request.byteLength) ? request.byteLength : 0;
  const checks = [];
  if (rule.minBytes !== undefined) checks.push(size >= rule.minBytes);
  if (rule.maxBytes !== undefined) checks.push(size <= rule.maxBytes);
  if (!checks.length) return null;
  return checks.every(Boolean);
}

/** 逐条件 AND。返回 { matched, details }，details 只保留真正参与判定的项。 */
export function matchRule(request, rule) {
  const details = {};
  let matched = true;
  let evaluated = 0;

  const pairs = [
    ['path', matchPath(request, rule)],
    ['modelPrefix', matchModelPrefix(request, rule)],
    ['bodyField', matchBodyField(request, rule)],
    ['bytes', matchBytes(request, rule)],
  ];

  for (const [key, verdict] of pairs) {
    if (verdict === null) continue;
    evaluated += 1;
    details[key] = verdict;
    if (!verdict) matched = false;
  }

  // 一个条件都没参与判定 → 这条规则视为"不适用"，而不是"命中一切"
  if (evaluated === 0) return { matched: false, details };
  return { matched, details };
}

/**
 * 选出请求落在哪个桶。
 *
 * @param {{path?:string, method?:string, body?:object, byteLength?:number,
 *          clientModel?:string, resolvedModel?:string}} request
 * @param {object} routerConfig
 * @returns {{bucket:string, source:'rule'|'default'|'forced'|'disabled',
 *            ruleIndex:number|null, match:object|null, reason:string|null}}
 */
export function resolveRoute(request = {}, routerConfig = {}) {
  // 显式指定（--router <bucket>）优先于一切，也优先于 enabled=false ——
  // 用户都点名了，再被配置里的 enabled 挡掉只会让人困惑。
  if (typeof routerConfig.forced === 'string' && routerConfig.forced) {
    return { bucket: routerConfig.forced, source: 'forced', ruleIndex: null, match: null, reason: null };
  }

  if (routerConfig.enabled === false) {
    return { bucket: 'default', source: 'disabled', ruleIndex: null, match: null, reason: null };
  }

  const rules = Array.isArray(routerConfig.rules) ? routerConfig.rules : [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule || !hasMatcher(rule)) continue;
    const verdict = matchRule(request, rule);
    if (verdict.matched) {
      return {
        bucket: rule.bucket,
        source: 'rule',
        ruleIndex: index,
        match: verdict.details,
        reason: rule.reason || null,
      };
    }
  }

  const fallback = typeof routerConfig.defaultBucket === 'string' && routerConfig.defaultBucket
    ? routerConfig.defaultBucket
    : 'default';
  return { bucket: fallback, source: 'default', ruleIndex: null, match: null, reason: null };
}

/** 取桶定义，没定义过的桶名退化成空桶（默认行为：什么都不做）。 */
export function getBucket(routerConfig = {}, name) {
  const bucket = routerConfig.buckets?.[name];
  if (!isPlainObject(bucket)) return emptyBucket();
  return {
    model: typeof bucket.model === 'string' && bucket.model ? bucket.model : null,
    transformers: Array.isArray(bucket.transformers) ? bucket.transformers.filter((x) => typeof x === 'string') : [],
  };
}

/**
 * 应用桶指定的模型覆盖，直接改 body。
 * 只改模型名——变换由 transformers 模块负责，两件事分开才好单独关掉其中一个。
 */
export function applyBucketModel(body, bucket, modelConfig = {}) {
  const target = bucket?.model;
  if (!target || !isPlainObject(body)) return { changed: false };
  const field = modelConfig.field || 'model';
  const from = body[field];
  if (from === target) return { changed: false, from, to: target };
  body[field] = target;
  return { changed: true, from, to: target };
}

/**
 * 合成这个请求最终要跑的变换列表。
 *
 * 全局 enabled（与 router 无关，始终生效）+ 命中桶挂载的变换，
 * 按顺序拼接并去重——全局在前，所以桶只能「追加」不能「取消」；
 * 想取消某个全局变换就直接别写进全局列表。
 */
export function composeTransformers(transformersConfig = {}, bucket = emptyBucket()) {
  const merged = [];
  for (const name of transformersConfig.enabled || []) {
    if (typeof name === 'string' && name && !merged.includes(name)) merged.push(name);
  }
  for (const name of bucket?.transformers || []) {
    if (typeof name === 'string' && name && !merged.includes(name)) merged.push(name);
  }
  return merged;
}

/** 供 doctor / --print-config 展示：桶名 + 模型覆盖 + 挂载的变换。 */
export function describeBuckets(routerConfig = {}) {
  const declared = Object.keys(routerConfig.buckets || {});
  const names = [...new Set([...BUILTIN_BUCKETS, ...declared])];
  return names.map((name) => {
    const bucket = getBucket(routerConfig, name);
    return {
      name,
      declared: declared.includes(name),
      model: bucket.model,
      transformers: bucket.transformers,
    };
  });
}

/**
 * 规则的人类可读摘要，用在 --dry-run 的规则表里。
 * 例：`path^=/v1/messages AND model~=think -> think`
 */
export function describeRule(rule) {
  const parts = [];
  if (rule.path !== undefined) parts.push(`path^=${rule.path}`);
  if (rule.modelPrefix !== undefined) parts.push(`model~=${rule.modelPrefix}*`);
  if (rule.bodyField !== undefined) {
    parts.push(
      rule.bodyFieldValue === undefined ? `has(${rule.bodyField})` : `${rule.bodyField}=${JSON.stringify(rule.bodyFieldValue)}`,
    );
  }
  if (rule.minBytes !== undefined) parts.push(`bytes>=${rule.minBytes}`);
  if (rule.maxBytes !== undefined) parts.push(`bytes<=${rule.maxBytes}`);
  return parts.length ? parts.join(' AND ') : t('router.ruleNoMatch');
}
