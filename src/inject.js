import { renderDeep, renderTemplate } from './template.js';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value);
    else target[key] = value;
  }
  return target;
}

function deleteByPath(target, keyPath) {
  const segments = keyPath.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor = cursor?.[segments[i]];
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return;
  }
  if (cursor && typeof cursor === 'object') delete cursor[segments[segments.length - 1]];
}

/** 按规则重写请求路径（例如把客户端用的 /v1/ 映射到上游的 /zen/go/v1/）。 */
export function rewritePath(originalPath, rules = []) {
  let result = originalPath;
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, rule.flags);
    result = result.replace(re, rule.replacement);
  }
  return result;
}

/**
 * 模型名重写：
 *   1. map 精确映射优先（别名 -> 真实模型名）
 *   2. stripPrefixes 逐条剥离（Trae 等客户端必须用 proxy- 前缀避开内置通道时使用）
 *   3. default 兜底
 * 返回 { changed, from, to }，未变化时 changed=false。
 */
export function rewriteModel(body, modelConfig, { logger } = {}) {
  if (!modelConfig?.enabled || !isPlainObject(body)) return { changed: false };
  const field = modelConfig.field || 'model';
  const original = body[field];
  if (typeof original !== 'string' || !original) return { changed: false };

  let next = original;
  if (modelConfig.map && Object.prototype.hasOwnProperty.call(modelConfig.map, original)) {
    next = modelConfig.map[original];
  } else {
    for (const prefix of modelConfig.stripPrefixes || []) {
      if (prefix && next.startsWith(prefix)) {
        next = next.slice(prefix.length);
        break;
      }
    }
  }
  if ((!next || next === original) && modelConfig.default) next = modelConfig.default;
  if (!next || next === original) return { changed: false, from: original, to: original };

  body[field] = next;
  logger?.debug(`[model] ${original} -> ${next}`);
  return { changed: true, from: original, to: next };
}

/** 按配置往请求体里补字段 / 删字段。 */
export function applyBodyInject(body, injectConfig, ctx) {
  if (!isPlainObject(body) || !injectConfig) return { changed: false };
  const changes = [];

  if (injectConfig.body && Object.keys(injectConfig.body).length) {
    const rendered = renderDeep(injectConfig.body, ctx);
    const before = JSON.stringify(body);
    if (injectConfig.overwrite === false) {
      const patch = {};
      for (const [key, value] of Object.entries(rendered)) {
        if (!(key in body)) patch[key] = value;
      }
      mergeInto(body, patch);
    } else {
      mergeInto(body, rendered);
    }
    if (JSON.stringify(body) !== before) changes.push(`body:${Object.keys(rendered).join(',')}`);
  }

  for (const keyPath of injectConfig.removeBodyFields || []) {
    if (typeof keyPath === 'string' && keyPath) {
      deleteByPath(body, keyPath);
      changes.push(`body-${keyPath}`);
    }
  }

  return { changed: changes.length > 0, changes };
}

/**
 * 生成需要注入/覆盖的请求头。
 * inject.overwrite === false 时，已存在的请求头不会被覆盖。
 */
export function buildInjectHeaders(injectConfig, ctx, existingLower = new Map()) {
  const out = {};
  const headers = injectConfig?.headers || {};
  for (const [name, template] of Object.entries(headers)) {
    if (template === null || template === undefined) continue;
    const lower = name.toLowerCase();
    if (injectConfig.overwrite === false && existingLower.has(lower)) continue;
    const value = renderTemplate(String(template), ctx);
    if (value === '') continue;
    out[lower] = value;
  }
  return out;
}
