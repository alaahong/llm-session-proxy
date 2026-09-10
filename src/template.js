import crypto from 'node:crypto';

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

function randomHex(length = 26) {
  let out = '';
  while (out.length < length) out += crypto.randomBytes(32).toString('hex');
  return out.slice(0, length);
}

function randomBase36(length = 26) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % 36];
  return out;
}

/** 内置模板函数。`{{name}}` 或带参 `{{name:arg}}`。 */
export function builtinFunctions() {
  return {
    uuid: () => crypto.randomUUID(),
    random: (arg) => randomHex(Number(arg) > 0 ? Number(arg) : 26),
    randomHex: (arg) => randomHex(Number(arg) > 0 ? Number(arg) : 16),
    randomBase36: (arg) => randomBase36(Number(arg) > 0 ? Number(arg) : 16),
    timestamp: () => Math.floor(Date.now() / 1000),
    timestampMs: () => Date.now(),
    now: () => new Date().toISOString(),
  };
}

/**
 * 创建模板上下文。所有字段都是纯对象，取值走点路径，行为可预测。
 *
 * 可用变量：
 *   {{session.id}} {{session.count}} {{session.requestId}} {{session.key}} {{session.source}}
 *   {{model}} {{path}} {{method}} {{uuid}} {{random}} {{randomHex:16}} {{timestamp}}
 *   {{env.HOME}} {{header.authorization}} {{query.foo}}
 */
export function createContext(extra = {}) {
  return {
    ...extra,
    env: extra.env || process.env,
    functions: { ...builtinFunctions(), ...(extra.functions || {}) },
  };
}

function lookup(expr, ctx) {
  let cursor = ctx;
  for (const segment of expr.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return '';
    cursor = cursor[segment];
  }
  if (cursor === undefined || cursor === null) return '';
  return typeof cursor === 'object' ? JSON.stringify(cursor) : String(cursor);
}

/** 渲染 `{{...}}` 模板。非字符串或没有占位符时原样返回。 */
export function renderTemplate(input, ctx = {}) {
  if (typeof input !== 'string' || !input.includes('{{')) return input;
  return input.replace(TEMPLATE_RE, (_match, rawExpr) => {
    const expr = rawExpr.trim();
    const colon = expr.indexOf(':');
    const name = colon === -1 ? expr : expr.slice(0, colon);
    const arg = colon === -1 ? undefined : expr.slice(colon + 1).trim();
    const fn = ctx.functions ? ctx.functions[name] : undefined;
    if (typeof fn === 'function') {
      try {
        const value = fn(arg);
        return value === undefined || value === null ? '' : String(value);
      } catch {
        return '';
      }
    }
    return lookup(expr, ctx);
  });
}

/** 对对象/数组里的所有字符串值递归渲染模板。 */
export function renderDeep(value, ctx) {
  if (typeof value === 'string') return renderTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, ctx);
    return out;
  }
  return value;
}

export { randomHex, randomBase36 };
