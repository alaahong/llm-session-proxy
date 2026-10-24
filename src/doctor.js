import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

import { resolveLogFile, resolveUpstream } from './config.js';
import { createCopilotSessionManager } from './copilot.js';
import { rewriteModel } from './inject.js';
import { logDetail } from './logger.js';
import { t } from './messages.js';
import { DEFAULT_MODEL_MAP } from './models.js';
import { describeProtocolRoute, detectProtocol, resolveProtocolRoute } from './protocol.js';
import { isForbiddenPort } from './ports.js';
import { composeTransformers, describeBuckets, describeRule, getBucket, resolveRoute } from './router.js';
import { listScorers } from './scoring.js';
import { generateId } from './session.js';
import { createContext, renderTemplate } from './template.js';
import { listTransformers } from './transformers.js';
import { describeProvider, normalizeProvider, credentialHeaderSpec, providerHeaders, resolveUpstream as resolvePoolUpstream } from './upstreams.js';

/**
 * 配置体检与路由预演。
 *
 * 两个入口共用同一份诊断：
 *   --dry-run   只做静态分析，一个字节都不发出去
 *   --doctor    在静态分析之上，额外探测上游可达性与监听端口占用
 *
 * 刻意**不发送聊天请求**：普通探测只到 DNS / TCP / TLS 为止，不碰上游的
 * 对话配额。唯一带凭据的调用是 Copilot provider 的 `GET /models`——
 * 它只回答「这个 token 能不能用」，不消耗 token 配额，也不会把凭据写进
 * 任何输出。想知道「密钥对不对」除此之外只能由客户端自己发一次真实请求。
 */

/** 全角字符按 2 列计算，否则中英混排的标签列会歪。 */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
      char,
    )
      ? 2
      : 1;
  }
  return width;
}

function padLabel(label, width) {
  return `${label}${' '.repeat(Math.max(1, width - displayWidth(label) + 2))}`;
}

/**
 * 挑一个用来演示的模型名。
 *
 * 默认拿映射表的第一条并补上第一个前缀（例如 `proxy-glm`），
 * 这样预演走的是「剥前缀 + 查映射」这条最容易出错的路径，
 * 而不是「客户端直接填真实 ID」这条永远通的路。
 */
export function pickSampleModel(config = {}, requested = null) {
  if (requested) return String(requested);
  const prefix = (config.model?.stripPrefixes || [])[0] || '';
  const alias = Object.keys(config.model?.map || {})[0];
  if (alias) return `${prefix}${alias}`;
  return prefix ? `${prefix}example-model` : 'example-model';
}

/**
 * 解释一个模型名会被怎么改写。
 *
 * 结果分类（outcome）：
 *   mapped            命中映射表（最理想）
 *   default           没命中，落到 model.default
 *   stripped-unmapped 剥了前缀但没映射也没兜底 —— 「模型不存在」的典型成因
 *   passthrough       没匹配任何前缀，原样转发（客户端填的是真实 ID，正常）
 */
export function explainModel(modelConfig = {}, sample) {
  const field = modelConfig.field || 'model';
  const body = { [field]: String(sample) };
  const result = rewriteModel(body, modelConfig, {});
  const map = modelConfig.map || {};
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  const original = String(sample);
  const strippedName = result.strippedPrefix ? original.slice(result.strippedPrefix.length) : null;
  const aliasKey = hasOwn(map, original) ? original : strippedName !== null && hasOwn(map, strippedName) ? strippedName : null;

  let outcome = 'passthrough';
  if (result.mapped) outcome = 'mapped';
  else if (result.usedDefault) outcome = 'default';
  else if (result.unmappedAlias) outcome = 'stripped-unmapped';

  return {
    field,
    sample: original,
    resolved: body[field],
    changed: result.changed,
    outcome,
    strippedPrefix: result.strippedPrefix,
    strippedName,
    aliasKey,
  };
}

/** 映射表里有多少条来自内置表、多少条被用户改写或新增。 */
export function mapComposition(modelConfig = {}) {
  const map = modelConfig.map || {};
  const keys = Object.keys(map);
  const overrides = keys.filter((key) => map[key] !== DEFAULT_MODEL_MAP[key]).length;
  return { total: keys.length, builtin: keys.length - overrides, overrides };
}

/**
 * 静态诊断：把「这个配置会怎么工作」整理成结构化的行。
 * 纯函数，不联网、不建日志文件、不监听端口 —— 便于单测与内嵌使用。
 */
export function diagnose(config, { model = null, env = process.env, name = 'llm-session-proxy' } = {}) {
  const upstream = resolveUpstream(config);
  const warnings = [];
  const problems = [];
  const sections = [];

  const configFile = config.__configPath || null;
  sections.push({
    title: t('doctor.section.config'),
    rows: [
      [t('doctor.label.file'), configFile || t('doctor.value.none')],
      [t('doctor.label.language'), String(config.lang)],
      [t('doctor.label.listen'), `${config.listen.host}:${config.listen.port}`],
    ],
  });

  sections.push({
    title: t('doctor.section.upstream'),
    rows: [
      [t('doctor.label.url'), `${upstream.protocol}://${upstream.hostHeader}${upstream.basePath}`],
      [t('doctor.label.hostHeader'), upstream.hostHeader],
      [t('doctor.label.basePath'), config.upstream.basePath || t('doctor.value.none')],
      [t('doctor.label.rewriteHost'), config.upstream.rewriteHost === false ? t('doctor.value.no') : t('doctor.value.yes')],
      [t('doctor.label.userAgent'), t('doctor.value.ua', { ua: config.userAgent, mode: config.userAgentMode })],
    ],
  });

  const pathRewrite = (config.request.pathRewrite || []).length
    ? config.request.pathRewrite.map((rule) => `${rule.pattern} => ${rule.replacement}`).join(' | ')
    : t('doctor.value.passthrough');
  sections.push({
    title: t('doctor.section.routing'),
    rows: [
      [t('doctor.label.pathRewrite'), pathRewrite],
      [
        t('doctor.label.sessionFrom'),
        t('doctor.value.sessionFrom', {
          headers: (config.session.headerNames || []).join(', ') || t('doctor.value.none'),
          body: (config.session.bodyFields || []).join(', ') || t('doctor.value.none'),
        }),
      ],
      [
        t('doctor.label.sessionId'),
        config.session.enabled
          ? `${config.session.idFormat} | ${config.session.requestIdFormat}`
          : t('doctor.value.none'),
      ],
    ],
  });

  // ---- 注入：用一份样例上下文真的渲染一遍，把「模板写错了」当场暴露 ----
  const sample = pickSampleModel(config, model);
  const session = {
    id: generateId({ prefix: config.session.idPrefix, format: config.session.idFormat }),
    count: 1,
    key: '',
    source: 'doctor',
    requestId: '',
  };
  const ctx = createContext({
    session,
    model: sample,
    path: '/v1/chat/completions',
    method: 'POST',
    header: {},
    query: {},
    env,
  });
  // requestId 本身也是模板，先渲染再回头供注入头引用（ctx.session 与 session 是同一个对象）
  session.requestId = renderTemplate(config.session.requestIdFormat || '', ctx);

  const injectionRows = [];
  for (const [header, template] of Object.entries(config.inject.headers || {})) {
    const rendered = template === null || template === undefined ? '' : renderTemplate(String(template), ctx);
    injectionRows.push([
      t('doctor.label.injectHeader'),
      t('doctor.value.headerRow', {
        name: header,
        template: template === null || template === undefined ? t('doctor.value.none') : String(template),
        rendered: rendered || t('doctor.value.none'),
      }),
    ]);
  }
  if (!injectionRows.length) injectionRows.push([t('doctor.label.injectHeader'), t('doctor.value.none')]);
  injectionRows.push([
    t('doctor.label.injectBody'),
    Object.keys(config.inject.body || {}).join(', ') || t('doctor.value.none'),
  ]);
  injectionRows.push([
    t('doctor.label.removeBody'),
    (config.inject.removeBodyFields || []).join(', ') || t('doctor.value.none'),
  ]);
  sections.push({ title: t('doctor.section.injection'), rows: injectionRows });

  // ---- 模型解析 ----
  const explanation = explainModel(config.model, sample);
  const composition = mapComposition(config.model);
  const modelRows = [[t('doctor.label.sample'), explanation.sample]];
  if (explanation.strippedPrefix) {
    modelRows.push([
      t('doctor.label.strip'),
      t('doctor.model.stripped', { prefix: explanation.strippedPrefix, resolved: explanation.strippedName }),
    ]);
  }
  if (explanation.outcome === 'mapped') {
    modelRows.push([
      t('doctor.label.mapped'),
      t('doctor.model.mapped', { alias: explanation.aliasKey, resolved: explanation.resolved }),
    ]);
  }
  const outcomeKey = {
    mapped: 'doctor.model.resultMapped',
    default: 'doctor.model.resultDefault',
    'stripped-unmapped': 'doctor.model.resultStrippedUnmapped',
    passthrough: 'doctor.model.resultPassthrough',
  }[explanation.outcome];
  modelRows.push([t('doctor.label.mapResult'), t(outcomeKey, { resolved: explanation.resolved })]);
  modelRows.push([
    t('doctor.label.map'),
    t('doctor.value.mapSize', { builtin: composition.builtin, overrides: composition.overrides }),
  ]);
  sections.push({ title: t('doctor.section.model'), rows: modelRows });

  // ---- 路由分桶与变换 ----
  // 用样例请求真的跑一遍 resolveRoute：用户最常问的就是「这条请求会落哪个桶」。
  const samplePath = '/v1/chat/completions';
  const sampleBody = { model: sample };
  const route = resolveRoute(
    {
      path: samplePath,
      method: 'POST',
      body: sampleBody,
      byteLength: Buffer.byteLength(JSON.stringify(sampleBody), 'utf8'),
      clientModel: sample,
      resolvedModel: explanation.resolved,
    },
    config.router,
  );
  const bucket = getBucket(config.router, route.bucket);
  const effective = composeTransformers(config.transformers, bucket);

  const routeRows = [];
  if (config.router.forced) {
    routeRows.push([t('doctor.label.routerEnabled'), t('doctor.value.forced', { bucket: config.router.forced })]);
  } else {
    routeRows.push([
      t('doctor.label.routerEnabled'),
      config.router.enabled === false ? t('doctor.value.no') : t('doctor.value.yes'),
    ]);
  }
  routeRows.push([t('doctor.label.defaultBucket'), config.router.defaultBucket || 'default']);

  // 难度打分器与档位（v0.3.0）。这一段最要紧的是「配了没有」——
  // 没配打分器时 difficulty 规则永远不命中，而规则看上去完全正常。
  const scorerNames = Array.isArray(config.router.scorers?.enabled) ? config.router.scorers.enabled : [];
  if (scorerNames.length) {
    routeRows.push([t('doctor.label.scorers'), scorerNames.join(', ')]);
    routeRows.push([t('doctor.label.availableScorers'), listScorers().join(', ')]);
    const bands = Array.isArray(config.router.bands) ? config.router.bands : [];
    routeRows.push([
      t('doctor.label.bands'),
      bands.length ? bands.map((b) => `${b.name}<=${b.maxScore}`).join('  ') : t('doctor.value.none'),
    ]);
    if (route.difficulty) {
      routeRows.push([
        t('doctor.label.sampleDifficulty'),
        t('doctor.value.sampleDifficulty', {
          band: route.difficulty,
          score: route.score ?? 0,
          signals: route.signals || {},
        }),
      ]);
    }
  } else {
    routeRows.push([t('doctor.label.scorers'), t('doctor.value.noScorers')]);
  }

  for (const entry of describeBuckets(config.router)) {
    const bits = [];
    if (entry.model) bits.push(`model=${entry.model}`);
    if (entry.transformers.length) bits.push(`transformers=${entry.transformers.join(',')}`);
    if (entry.upstream) bits.push(`upstream=${entry.upstream}`);
    routeRows.push([t('doctor.label.bucketRow', { name: entry.name }), bits.join(' ') || t('doctor.value.none')]);
  }
  const rules = config.router.rules || [];
  if (rules.length) {
    rules.forEach((rule, index) => {
      routeRows.push([`#${index}`, `${describeRule(rule)} -> ${rule.bucket}`]);
    });
  } else {
    routeRows.push([t('doctor.label.rules'), t('doctor.value.noRules')]);
  }
  const routeLabelKey = {
    rule: 'doctor.value.routeBy',
    forced: 'doctor.value.routeForced',
    default: 'doctor.value.routeDefault',
    disabled: 'doctor.value.disabled',
  }[route.source];
  routeRows.push([
    t('doctor.label.sampleRoute'),
    t(routeLabelKey, { bucket: route.bucket, index: route.ruleIndex ?? -1, path: samplePath }),
  ]);
  sections.push({ title: t('doctor.section.router'), rows: routeRows });

  sections.push({
    title: t('doctor.section.transformers'),
    rows: [
      [t('doctor.label.globalTransformers'), (config.transformers.enabled || []).join(', ') || t('doctor.value.none')],
      [t('doctor.label.effectiveTransformers'), effective.join(', ') || t('doctor.value.none')],
      [t('doctor.label.availableTransformers'), listTransformers().join(', ')],
    ],
  });

  // ---- 协议互转 ----
  // 与路由分桶同一个思路：用样例请求真的跑一遍 resolveProtocolRoute，
  // 直接告诉用户「这条请求会被转成哪套协议、发哪条路径」。
  const sampleSource = detectProtocol(samplePath);
  const protoRoute = resolveProtocolRoute(
    { clientModel: sample, resolvedModel: explanation.resolved },
    config.protocol,
  );
  const protoRows = [];
  if (config.protocol?.forced) {
    protoRows.push([t('doctor.label.protocolEnabled'), t('doctor.value.protocolForced', { target: config.protocol.forced })]);
  } else {
    protoRows.push([
      t('doctor.label.protocolEnabled'),
      config.protocol?.enabled === false ? t('doctor.value.protocolOff') : t('doctor.value.yes'),
    ]);
  }
  const protoPaths = config.protocol?.paths || {};
  protoRows.push([
    t('doctor.label.protocolPaths'),
    ['chat', 'messages', 'responses']
      .map((name) => `${name}=${protoPaths[name] || '-'}`)
      .join(t('log.join')),
  ]);
  const protoRoutesList = Array.isArray(config.protocol?.routes) ? config.protocol.routes : [];
  if (protoRoutesList.length) {
    protoRoutesList.forEach((rule, index) => {
      protoRows.push([`#${index}`, describeProtocolRoute(rule)]);
    });
  } else {
    protoRows.push([t('doctor.label.rules'), t('doctor.value.noRules')]);
  }
  if (sampleSource && protoRoute.target) {
    const via =
      (sampleSource === 'messages' && protoRoute.target === 'responses') ||
      (sampleSource === 'responses' && protoRoute.target === 'messages')
        ? 'chat'
        : null;
    const sampleValue =
      protoRoute.target === sampleSource
        ? t('doctor.value.protocolSame', { protocol: sampleSource })
        : t('doctor.value.protocolConvert', { from: sampleSource, to: protoRoute.target, via });
    const hitRoute = protoRoute.index != null ? protoRoutesList[protoRoute.index] : null;
    const targetPath = hitRoute?.path || protoPaths[protoRoute.target];
    protoRows.push([
      t('doctor.label.protocolSample'),
      targetPath ? `${sampleValue}  ${targetPath}` : sampleValue,
    ]);
  } else {
    protoRows.push([t('doctor.label.protocolSample'), t('doctor.value.protocolNone')]);
  }
  sections.push({ title: t('doctor.section.protocol'), rows: protoRows });

  // ---- 上游池（v0.3.0）----
  // 池子是空的 = 只有一个上游，行为与 v0.2 完全一样。
  // 有池子时要说清「哪个模型走哪个上游」「凭据从哪来」「用什么协议」。
  const pool = config.upstreams || {};
  const poolProviders = pool.providers && typeof pool.providers === 'object' ? pool.providers : {};
  const poolNames = Object.keys(poolProviders);
  const poolRows = [];
  if (!poolNames.length) {
    poolRows.push([t('doctor.label.upstreamPool'), t('doctor.value.poolEmpty')]);
    poolRows.push([t('doctor.label.poolDefault'), config.upstream.hostHeader || t('doctor.value.none')]);
  } else {
    poolRows.push([t('doctor.label.upstreamPool'), t('doctor.value.poolSize', { count: poolNames.length })]);
    poolRows.push([
      t('doctor.label.poolDefault'),
      pool.default ? `${pool.default}` : t('doctor.value.poolNoDefault'),
    ]);
    for (const name of poolNames) {
      const provider = poolProviders[name];
      const info = describeProvider(provider);
      const bits = [`type=${info.type}`, `wire=${info.wire.join('|') || '-'}`];
      if (info.credential) bits.push(`credential=${info.credential}`);
      if (info.tokenMode) bits.push(`mode=${info.tokenMode}`);
      poolRows.push([t('doctor.label.poolProvider', { name }), bits.join(' ')]);
    }
    const poolRoutes = Array.isArray(pool.routes) ? pool.routes : [];
    if (poolRoutes.length) {
      poolRoutes.forEach((rule, index) => {
        poolRows.push([`#${index}`, `${rule.model || '*'} -> ${rule.upstream}`]);
      });
    } else {
      poolRows.push([t('doctor.label.rules'), t('doctor.value.noRules')]);
    }
    // 样例请求会落到哪个上游
    const picked = resolvePoolUpstream({
      model: explanation.resolved,
      clientModel: sample,
      bucketUpstream: bucket.upstream,
      upstreamConfig: pool,
    });
    poolRows.push([
      t('doctor.label.poolSample'),
      picked.name
        ? t('doctor.value.poolSample', { name: picked.name, source: picked.source })
        : t('doctor.value.poolNone'),
    ]);
  }
  sections.push({ title: t('doctor.section.upstreams'), rows: poolRows });

  const resolvedLog = resolveLogFile(config.log, { name, env });
  sections.push({
    title: t('doctor.section.log'),
    rows: [
      [t('doctor.label.logFile'), resolvedLog || t('doctor.value.none')],
      [t('doctor.label.rotation'), logDetail(config.log)],
    ],
  });

  // ---- 静态可判定的警告 ----
  if (!composition.total && (config.model.stripPrefixes || []).length) {
    warnings.push(t('doctor.warn.modelMapEmpty'));
  }
  if (config.router.enabled && !config.router.forced) {
    const configured = describeBuckets(config.router).some((entry) => entry.model || entry.transformers.length);
    if (!rules.length && !configured) {
      // 开了 router 却什么都没配，等于白白多一层判定，明说比让人纳闷好
      warnings.push(t('doctor.warn.routerEmpty'));
    }
  }
  if (config.protocol?.enabled !== false && !config.protocol?.forced) {
    if (!protoRoutesList.length) {
      // 互转层开着却没有一条规则，等于每次请求白查一遍表
      warnings.push(t('doctor.warn.protocolEmpty'));
    }
  }
  if (isForbiddenPort(config.listen?.port)) {
    // 这种端口 Node 绑得上，浏览器和 fetch 客户端却按 WHATWG 规范直接拒绝——
    // 服务起来了但谁都连不上，且日志里一点痕迹都没有，所以体检要明说。
    warnings.push(t('doctor.warn.forbiddenPort', { port: config.listen.port }));
  }
  if (explanation.outcome === 'stripped-unmapped') {
    const message = t('doctor.fail.unresolvedAlias', {
      alias: explanation.sample,
      resolved: explanation.resolved,
    });
    // 用户明确点名要查这个别名 → 这是问题；只是自动取样的 → 提醒即可
    if (model) problems.push(message);
    else warnings.push(message);
  }

  return { sections, warnings, problems, explanation, upstream, sample, resolvedLog };
}

/** DNS 解析。IP 字面量会直接返回自身，不算失败。 */
export async function probeDns(host) {
  try {
    const { address, family } = await dns.lookup(host);
    return { ok: true, address, family };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

/** TCP 连通性 + 握手耗时。 */
export function probeTcp({ host, port, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, ms: Date.now() - started }));
    socket.once('timeout', () => finish({ ok: false, timeout: true, ms: Date.now() - started }));
    socket.once('error', (error) => finish({ ok: false, message: error.message }));
  });
}

/**
 * TLS 握手。
 *
 * `rejectUnauthorized: false` 是刻意的：自签证书的上游也应该被判定为「连得上」，
 * 但校验结果会如实报出来（certificate NOT verified），而不是替用户做决定。
 * 这里不发送任何应用层数据，所以放宽校验不等于传递了敏感内容。
 */
export function probeTls({ host, port, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    // socket.setTimeout 只在「一段时间没有活动」时触发——对端连上但一直不说话时，
    // 握手会永远挂着。所以这里另起一个**硬超时**：到点必结，不看 socket 状态。
    // 没有它，探测一个明文端口就能让整个 doctor 体检卡死。
    // 刻意**不** unref——探测期间必须让事件循环保持活着，否则定时器会被跳过。
    const hardTimer = setTimeout(() => finish({ ok: false, timeout: true }), timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () =>
      finish({
        ok: true,
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
        subject: socket.getPeerCertificate()?.subject?.CN || null,
      }),
    );
    socket.once('timeout', () => finish({ ok: false, timeout: true }));
    socket.once('error', (error) => finish({ ok: false, message: error.message }));
  });
}

/** 监听端口是否可用。占用本身不是致命问题（可能已经跑着一个实例）。 */
export function checkListenPort({ host, port }) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        server.close();
      } catch {
        /* 没在监听就没什么可关的 */
      }
      resolve(result);
    };
    // 与 probeTls 同一个道理：listen 到 listening 之间可能既不报错也不就绪，
    // 没有硬超时就可能永远挂着，体检卡死。同样不 unref。
    const hardTimer = setTimeout(() => finish({ ok: false, message: 'listen probe timed out' }), 8000);
    server.once('error', (error) => finish({ ok: false, code: error.code, message: error.message }));
    server.once('listening', () => finish({ ok: true }));
    try {
      server.listen(port, host);
    } catch (error) {
      finish({ ok: false, message: error.message });
    }
  });
}

/**
 * 探测上游池里的 Copilot provider。
 *
 * 每个 provider 单独取一次凭据（来源与模式都可能不同），再调用
 * `GET {baseUrl}/models`：200 = token 可用；401 / 403 = 凭据或 Copilot 权限有问题。
 * 这是一次只读调用，不消耗对话配额；token 只出现在请求头里，
 * **绝不进入返回值、检查项或错误信息**。
 */
export async function checkCopilotUpstreams(
  config,
  { env = process.env, timeoutMs = 8000, fetchImpl = globalThis.fetch, manager = null } = {},
) {
  const pool = config?.upstreams;
  const providers = pool?.providers && typeof pool.providers === 'object' ? pool.providers : {};
  const targets = Object.entries(providers).filter(([, provider]) => provider?.type === 'copilot');
  const checks = [];
  const problems = [];
  if (!targets.length) return { checks, problems };

  const sessionManager = manager || createCopilotSessionManager({ env });

  for (const [name, raw] of targets) {
    const provider = normalizeProvider(name, raw);
    try {
      const auth = provider.auth && typeof provider.auth === 'object' ? provider.auth : {};
      const token = await sessionManager.get({
        envNames: typeof auth.env === 'string' ? auth.env.split(',').map((item) => item.trim()).filter(Boolean) : [],
        command: typeof auth.command === 'string' ? auth.command : null,
        allowCommand: auth.allowCommand !== false,
        tokenMode: auth.tokenMode,
        // 体检不能把人拖进交互式登录：没凭据就如实报「取不到」
        allowDeviceFlow: false,
      });
      const spec = credentialHeaderSpec(provider);
      const headers = { ...providerHeaders(provider), [spec.header]: `${spec.prefix}${token.token}` };
      if (!headers.accept) headers.accept = 'application/json';
      const response = await fetchImpl(`${provider.baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        checks.push(t('doctor.check.copilotFail', { name, message: `HTTP ${response.status}` }));
        problems.push(t('doctor.fail.copilot', { name }));
        continue;
      }
      const body = await response.json().catch(() => null);
      const models = Array.isArray(body?.data) ? body.data.length : null;
      checks.push(
        t('doctor.check.copilotOk', {
          name,
          source: token.source,
          mode: token.mode || 'direct',
          models,
        }),
      );
    } catch (error) {
      checks.push(t('doctor.check.copilotFail', { name, message: error.message }));
      problems.push(t('doctor.fail.copilot', { name }));
    }
  }

  return { checks, problems };
}

/**
 * 完整跑一次体检。
 *
 * mode = 'dryRun'  → 只有静态诊断
 * mode = 'doctor'  → 静态诊断 + 上游可达性 + 监听端口 + Copilot 凭据
 */
export async function runDoctor(config, { mode = 'dryRun', model = null, env = process.env, name = 'llm-session-proxy', timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const diagnosis = diagnose(config, { model, env, name });

  if (mode === 'doctor') {
    const { host, port, protocol } = diagnosis.upstream;
    const checks = [];
    const dnsResult = await probeDns(host);
    if (dnsResult.ok) {
      checks.push(t('doctor.check.dnsOk', { host, address: dnsResult.address }));
      const tcpResult = await probeTcp({ host, port, timeoutMs });
      if (tcpResult.ok) {
        checks.push(t('doctor.check.tcpOk', { host, port, ms: tcpResult.ms }));
      } else {
        const detail = tcpResult.timeout
          ? t('doctor.check.timeout', { ms: timeoutMs })
          : tcpResult.message;
        checks.push(t('doctor.check.tcpFail', { host, port, message: detail }));
        diagnosis.problems.push(t('doctor.fail.connect', { host, port }));
      }

      if (tcpResult.ok && protocol === 'https') {
        const tlsResult = await probeTls({ host, port, timeoutMs });
        if (tlsResult.ok) {
          checks.push(
            t('doctor.check.tlsOk', {
              detail:
                (tlsResult.protocol ? ` (${tlsResult.protocol})` : '') +
                (tlsResult.authorized ? '' : t('doctor.check.tlsUnverified')),
            }),
          );
        } else {
          const detail = tlsResult.timeout ? t('doctor.check.timeout', { ms: timeoutMs }) : tlsResult.message;
          checks.push(t('doctor.check.tlsFail', { message: detail }));
          diagnosis.problems.push(t('doctor.fail.tls'));
        }
      }
    } else {
      checks.push(t('doctor.check.dnsFail', { host, message: dnsResult.message }));
      diagnosis.problems.push(t('doctor.fail.dns', { host }));
    }

    const portResult = await checkListenPort({ host: config.listen.host, port: config.listen.port });
    if (portResult.ok) {
      checks.push(t('doctor.check.portFree', { port: config.listen.port }));
    } else {
      checks.push(t('doctor.check.portBusy', { port: config.listen.port }));
      diagnosis.warnings.push(t('doctor.warn.portBusy', { port: config.listen.port }));
    }

    // Copilot provider 的凭据是真的可以「当场验证」的：解析一次凭据，
    // 再拿它打一次 /models，就知道它能不能用。
    const copilotProbe = await checkCopilotUpstreams(config, { env, timeoutMs, fetchImpl });
    checks.push(...copilotProbe.checks);
    diagnosis.problems.push(...copilotProbe.problems);

    checks.push(t('doctor.check.credentials', { header: 'authorization' }));

    diagnosis.checks = checks;
    diagnosis.sections.push({ title: t('doctor.section.checks'), rows: checks.map((line) => [null, line]) });
  }

  diagnosis.ok = diagnosis.problems.length === 0;
  diagnosis.mode = mode;
  return diagnosis;
}

/** 把诊断渲染成给人看的文本。 */
export function renderDiagnosis(diagnosis, { name = 'llm-session-proxy', version = '0.0.0' } = {}) {
  const modeLabel = diagnosis.mode === 'doctor' ? t('doctor.mode.doctor') : t('doctor.mode.dryRun');
  // 标签列宽在本语言的全部行里取最大值，中英各自对齐
  let labelWidth = 0;
  for (const section of diagnosis.sections) {
    for (const [label] of section.rows) {
      if (label) labelWidth = Math.max(labelWidth, displayWidth(label));
    }
  }

  const out = [`${t('doctor.title', { name, version, mode: modeLabel })}`, ''];
  for (const section of diagnosis.sections) {
    out.push(section.title);
    for (const [label, value] of section.rows) {
      out.push(label ? `  ${padLabel(label, labelWidth)}${value}` : `  ${value}`);
    }
    out.push('');
  }

  out.push(t('doctor.section.result'));
  if (diagnosis.problems.length) {
    out.push(`  ${t('doctor.problems', { count: diagnosis.problems.length, list: diagnosis.problems.join('\n  - ') })}`);
  }
  if (diagnosis.warnings.length) {
    out.push(`  ${t('doctor.warnings', { count: diagnosis.warnings.length, list: diagnosis.warnings.join('\n  - ') })}`);
  }
  if (diagnosis.problems.length) {
    out.push(`  ${t('doctor.result.fail', { count: diagnosis.problems.length })}`);
  } else {
    out.push(`  ${diagnosis.mode === 'doctor' ? t('doctor.result.okDoctor') : t('doctor.result.ok')}`);
  }
  return `${out.join('\n')}\n`;
}
