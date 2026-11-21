/**
 * 模型名里的来源前缀（v0.4）。
 *
 * 目的：同一个模型 ID 可能存在于多个上游（gpt-5 既可能在 Copilot 也可能在
 * 自己的 OpenAI 兼容供应商）。让客户端写 `copilot:gpt-5` 就能点名来源，
 * 同时在日志与用量统计里保留 `copilot:gpt-5` 这个可区分的展示名。
 *
 * 保守匹配：只有前缀 token 命中**已配置的 provider 名或别名**才算来源，
 * 否则原样放行。含冒号的模型 ID（如某些网关的 `vendor:model`）不会被误伤。
 *
 * 零依赖、纯函数，不碰 i18n：告警文案由调用方拼。
 */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从客户端模型名里拆出来源前缀。
 *
 * @param {string} model 客户端原始模型名（如 proxy-copilot:gpt-5）
 * @param {object} sourcePrefix config.model.sourcePrefix
 * @param {object} providers config.upstreams.providers（用于确认来源真实存在）
 * @param {string[]} stripPrefixes config.model.stripPrefixes（允许 proxy-copilot:... 这种写法）
 * @returns {{matched: boolean, source: string|null, model: string, rawSource: string|null, reason?: string}}
 */
export function parseModelSource(model, sourcePrefix = {}, providers = {}, stripPrefixes = []) {
  const result = { matched: false, source: null, model, rawSource: null };
  if (!sourcePrefix || sourcePrefix.enabled !== true) return result;
  if (typeof model !== 'string' || !model) return result;

  const separator = typeof sourcePrefix.separator === 'string' && sourcePrefix.separator
    ? sourcePrefix.separator
    : ':';
  const aliasMap = isPlainObject(sourcePrefix.aliases) ? sourcePrefix.aliases : {};
  const providerMap = isPlainObject(providers) ? providers : {};

  const tokens = [];
  const add = (token, canonical) => {
    if (typeof token !== 'string' || !token || token.includes(separator)) return;
    if (!tokens.some((item) => item.token === token)) tokens.push({ token, canonical });
  };
  for (const name of Object.keys(providerMap)) add(name, name);
  for (const [alias, target] of Object.entries(aliasMap)) {
    if (typeof target === 'string' && target) add(alias, target);
  }
  // 长名优先：aliases 里 gh 与 github 共存时，github:gpt-5 不能被 gh 截断
  tokens.sort((a, b) => b.token.length - a.token.length);

  const prefixes = ['', ...(Array.isArray(stripPrefixes) ? stripPrefixes.filter((p) => typeof p === 'string' && p) : [])];
  for (const token of tokens) {
    for (const prefix of prefixes) {
      const head = `${prefix}${token.token}${separator}`;
      if (model.startsWith(head) && model.length > head.length) {
        return {
          matched: true,
          source: token.canonical,
          // 保留剩下的 stripPrefix，交给 rewriteModel 按既有链处理
          model: model.slice(head.length),
          rawSource: token.token,
        };
      }
    }
  }
  return { ...result, reason: 'no-match' };
}

/**
 * 给展示用的模型名加来源前缀（日志与统计）。
 * 已带来源前缀时不重复加；没有来源时原样返回。
 */
export function displayModel(source, model) {
  if (typeof model !== 'string' || !model) return model;
  if (typeof source !== 'string' || !source) return model;
  if (model.startsWith(`${source}:`)) return model;
  return `${source}:${model}`;
}

/**
 * 该来源在池里是否真实存在。别名可能指向一个没配的 provider，
 * 这时不能悄悄按默认上游发——但也不该 500：调用方告警后回退常规路由。
 */
export function resolveSourceProvider(source, providers = {}) {
  if (typeof source !== 'string' || !source) return null;
  const map = isPlainObject(providers) ? providers : {};
  return Object.prototype.hasOwnProperty.call(map, source) ? source : null;
}
