import { t } from './messages.js';

/**
 * 协议识别与互转路由（v0.2.2）。
 *
 * 客户端用哪套协议，决定了它发来的请求体长什么样、也决定了它能读懂什么样的响应。
 * 本模块只回答两个问题：
 *   1. 这条请求是哪套协议（从路径推断，chat / messages / responses）；
 *   2. 这条请求该被转成哪套协议再发上游（按模型前缀查 protocol.routes）。
 *
 * 与 router 分桶的关系：router 决定「换哪个模型、挂哪些变换」，protocol 决定
 * 「用什么线格式、发哪条路径」。两者正交，先后各跑一遍。
 *
 * 转换器本身是树内具名函数（见 converters.js / replies.js），**刻意不从任意路径
 * 加载插件**——和 transformers.js 同一个取舍：配置文件不能指向代码。
 */

export const PROTOCOLS = ['chat', 'messages', 'responses'];

/** 路径 → 协议。按后缀识别，顺序即优先级（chat 最具体，放最前）。 */
const PATH_MARKERS = [
  ['chat', '/chat/completions'],
  ['responses', '/responses'],
  ['messages', '/messages'],
];

/** 从请求路径推断协议；认不出来返回 null（那就按既有行为原样转发）。 */
export function detectProtocol(path) {
  const value = String(path || '');
  for (const [protocol, marker] of PATH_MARKERS) {
    if (value.includes(marker)) return protocol;
  }
  return null;
}

/** 三种协议两两组合的转换器名（方向敏感）。 */
export function converterName(from, to) {
  if (!PROTOCOLS.includes(from) || !PROTOCOLS.includes(to) || from === to) return null;
  // messages <-> responses 走 chat 中转，注册表里没有直达对
  return `${from}->${to}`;
}

/**
 * 按模型前缀查互转路由。自上而下、首个命中即止，与 router 的规则同款语义；
 * `model` 缺省视为命中一切（整库只有一个上游协议时就是这么用的），doctor 会明说。
 * `forced`（--protocol <target>）优先于一切，也优先于 enabled=false —— 用户都点名了。
 *
 * @returns {{target:string, source:'forced'|'rule'|'none', index:number|null}}
 */
export function resolveProtocolRoute({ clientModel, resolvedModel }, protocolConfig) {
  if (typeof protocolConfig?.forced === 'string' && protocolConfig.forced) {
    return { target: protocolConfig.forced, source: 'forced', index: null };
  }
  if (protocolConfig?.enabled === false) return { target: null, source: 'none', index: null };
  const routes = Array.isArray(protocolConfig?.routes) ? protocolConfig.routes : [];
  const candidates = [clientModel, resolvedModel].filter((v) => typeof v === 'string' && v);
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    if (!route || typeof route.target !== 'string') continue;
    const prefix = typeof route.model === 'string' ? route.model : '';
    const hit = prefix ? candidates.some((value) => value.startsWith(prefix)) : true;
    if (hit) return { target: route.target, source: 'rule', index };
  }
  return { target: null, source: 'none', index: null };
}

/** 规则的人类可读摘要，给 doctor 用。 */
export function describeProtocolRoute(route) {
  const parts = [];
  parts.push(route.model ? `model~=${route.model}*` : 'model~=*');
  parts.push(`-> ${route.target}`);
  return parts.join(' ');
}

/** 目标协议的上游路径；route.path 显式指定时优先。 */
export function upstreamPathFor(target, protocolConfig, routePath) {
  if (typeof routePath === 'string' && routePath) return routePath;
  return protocolConfig?.paths?.[target] || null;
}
