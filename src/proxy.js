import http from 'node:http';
import https from 'node:https';
import { resolveUpstream, shouldReplaceUserAgent } from './config.js';
import { convertRequestBody } from './converters.js';
import { applyBodyInject, buildInjectHeaders, rewriteModel, rewritePath } from './inject.js';
import { detectProtocol, resolveProtocolRoute, upstreamPathFor } from './protocol.js';
import { convertResponseJson } from './replies.js';
import { listenUntilUsablePort } from './ports.js';
import { applyBucketModel, composeTransformers, getBucket, resolveRoute } from './router.js';
import { resolveSession, SessionStore } from './session.js';
import { createStreamTranscoder } from './stream.js';
import { createContext } from './template.js';
import { applyTransformers } from './transformers.js';
import { createCopilotSessionManager } from './copilot.js';
import {
  credentialHeaderSpec,
  normalizeUpstreams,
  parseProviderBaseUrl,
  providerHeaders,
  resolveApiKey,
  resolveUpstream as resolvePoolUpstream,
  resolveWire,
  upstreamPathFor as poolPathFor,
} from './upstreams.js';
import { t } from './messages.js';

/** 逐跳头不能转发给上游，也不能回给客户端。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
]);

const LOCAL_PREFIX = '/__llm_session_proxy__';
const ERROR_CAPTURE_BYTES = 4096;

/**
 * Node 校验 header / statusMessage 用的是 `/[^\t\x20-\x7e\x80-\xff]/`。
 * 这里复刻同一套规则：返回值合法就返回 true。
 */
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

function isValidHeaderValue(value) {
  return typeof value === 'string' && !INVALID_HEADER_CHAR.test(value);
}

/** 上游的 reason phrase 不合法时返回 null，交给 Node 用默认短语。 */
function sanitizeStatusMessage(message) {
  if (typeof message !== 'string' || message === '') return null;
  return INVALID_HEADER_CHAR.test(message) ? null : message;
}

/**
 * 丢掉含非法字符的响应头。
 *
 * 这些头来自上游，Node 的**入站**解析比**出站**写入宽松，所以完全可能出现
 * "能收进来、写不出去"的值；而 writeHead 抛的是同步异常，抛在事件回调里
 * 就是进程级崩溃。宁可丢掉个别头，也不能让进程死。
 */
function sanitizeResponseHeaders(headers, onDrop) {
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      const kept = value.filter((item) => isValidHeaderValue(item));
      if (kept.length) clean[key] = kept;
      // 只要丢了一部分就要记名，哪怕还剩得下几个。
      // 「部分丢弃」比「整组丢弃」更难查：客户端收到的是一份被悄悄改过的头，
      // 而上游到底发了什么，日志里一个字都没有 —— 那就等于静默吞掉。
      if (kept.length !== value.length) onDrop(key);
      continue;
    }
    if (isValidHeaderValue(value)) clean[key] = value;
    else onDrop(key);
  }
  return clean;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error(t('proxy.err.bodyTooLarge', { maxBytes }));
        error.code = 'E_TOO_LARGE';
        fail(error);
        // 不再收 body，但**不要**在这里 destroy 请求流——
        // destroy 会连带毁掉 socket，客户端就只看到「连接被重置」，
        // 收不到本来该给它的 413 答复。答复由调用方写，写完再断开。
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(Object.assign(new Error(t('proxy.err.clientAbortedBody')), { code: 'E_ABORTED' })));
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 创建代理服务器。
 *
 * 每个请求的处理顺序：
 *   读体 -> 解析 JSON -> 解析会话 -> 重写路径/模型 -> 注入头与体 -> 转发 -> 回传响应
 *
 * 稳定性约定（这里是踩过坑的地方）：
 *   handle() 是同步入口，任何抛出都必须被捕获。http 服务器的事件回调里
 *   冒出来的同步异常没有任何人接得住，Node 会直接终止整个进程——
 *   而且栈只打到 stderr，不进日志文件，表现就是「日志一切正常，进程凭空消失」。
 */
export function createProxyServer({ config, logger }) {
  const store = new SessionStore(config.session);
  const upstream = resolveUpstream(config);
  const stats = { startedAt: Date.now(), requests: 0, errors: 0, handledErrors: 0, bytesIn: 0, bytesOut: 0 };
  // 未命中的模型别名只喊一次：同一个错别名可能被打上千次，逐条告警会把日志淹掉。
  const warnedModels = new Set();
  const WARNED_MODELS_MAX = 256;

  // 上游池做一次防御性归一化。
  //
  // 为什么不直接信 config.upstreams：createProxyServer 是公开 API，
  // 调用方（尤其是内嵌用法）可能自己拼一份配置进来，跳过了 config.js 的
  // normalize()。那时 provider.paths / provider.wire 都不存在，
  // 路径替换会静默失效——请求原样打出去，症状是「路径没变」。
  // 这里补一次归一化，等于把「必须经过 config.js」这条隐含约定变成显式保证。
  const upstreamPool = normalizeUpstreams(config.upstreams);

  // agent 按 protocol://host:port 缓存。上游池意味着可能有多个上游，
  // 每个都要有自己的连接池——共用一个会让 keepAlive 打到别的 host 上。
  const agents = new Map();
  const getAgent = (protocol) => {
    const key = protocol === 'https' ? 'https' : 'http';
    if (!agents.has(key)) {
      agents.set(
        key,
        key === 'https'
          ? new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 30000 })
          : new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 30000 }),
      );
    }
    return agents.get(key);
  };

  // Copilot 的 token 管理器：默认直连 GitHub token；provider 配了
  // auth.tokenMode: "session" 才换短命 session token。内存缓存，不落盘。
  // allowCommand 默认开着（官方链的最后一环是 gh CLI）；
  // 某个 provider 配了 auth.allowCommand: false 就单独关掉它。
  const copilotSession = createCopilotSessionManager({
    allowCommand: true,
  });

  const agent = getAgent(upstream.protocol);

  const log = {
    error: (...a) => logger.error(...a),
    warn: (...a) => logger.warn(...a),
    info: (...a) => logger.info(...a),
    debug: (...a) => logger.debug(...a),
  };

  const guard = (req) => req.socket?.remoteAddress;

  /** 回写 JSON。客户端可能已经断开，写失败只能吞掉，绝不能因此抛出去。 */
  function respondJson(res, status, payload) {
    try {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      res.end(body);
    } catch (error) {
      log.debug(t('proxy.log.respondFailed', { message: error.message }));
      try {
        res.destroy();
      } catch {
        /* 已经没了就算了 */
      }
    }
  }

  /** 写响应头。上游的 reason phrase / 响应头可能触发 writeHead 同步抛错，这里兜住。 */
  function writeResponseHead(res, status, statusMessage, headers) {
    const safeMessage = sanitizeStatusMessage(statusMessage);
    if (safeMessage === null && statusMessage) {
      log.debug(t('proxy.log.badReasonPhrase', { value: JSON.stringify(statusMessage) }));
    }
    try {
      if (safeMessage) res.writeHead(status, safeMessage, headers);
      else res.writeHead(status, headers);
      return true;
    } catch (error) {
      stats.errors += 1;
      log.warn(t('proxy.log.writeHeadRetry', { message: error.message }));
      const fallback = sanitizeResponseHeaders(headers, (key) => log.warn(t('proxy.log.dropIllegalHeader', { key })));
      try {
        if (res.headersSent) {
          res.end();
          return true;
        }
        const retryMessage = sanitizeStatusMessage(statusMessage);
        if (retryMessage) res.writeHead(status, retryMessage, fallback);
        else res.writeHead(status, fallback);
        return true;
      } catch (retryError) {
        stats.errors += 1;
        log.error(t('proxy.log.writeHeadGaveUp', { message: retryError.message }));
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        return false;
      }
    }
  }

  function handleLocal(req, res, url) {
    if (url.pathname === `${LOCAL_PREFIX}/health` || url.pathname === `${LOCAL_PREFIX}/status`) {
      respondJson(res, 200, {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
        listen: `${config.listen.host}:${config.listen.port}`,
        upstream: `${upstream.protocol}://${upstream.hostHeader}${upstream.basePath}`,
        sessions: { active: store.size, hits: store.hits, misses: store.misses },
        stats: { ...stats },
        inject: {
          headers: Object.keys(config.inject.headers || {}),
          stripPrefixes: config.model.stripPrefixes,
        },
        configPath: config.__configPath || null,
      });
      return true;
    }
    if (url.pathname === `${LOCAL_PREFIX}/sessions`) {
      const items = [...store.map.entries()].map(([key, record]) => ({
        key,
        id: record.id,
        count: record.count,
        createdAt: record.createdAt,
        lastUsed: record.lastUsed,
      }));
      respondJson(res, 200, { count: items.length, items });
      return true;
    }
    return false;
  }

  /**
   * 同步入口：把所有同步抛出挡在这里，转成 500 而不是进程退出。
   */
  function handle(req, res) {
    try {
      dispatch(req, res);
    } catch (error) {
      stats.errors += 1;
      stats.handledErrors += 1;
      log.error(
        t('proxy.log.requestFailed', {
          method: req.method,
          url: req.url,
          detail: error?.stack || error?.message || error,
        }),
      );
      respondJson(res, 500, {
        error: {
          type: 'proxy_internal_error',
          message: t('proxy.err.internal', { message: error?.message || error }),
        },
      });
    }
  }

  function dispatch(req, res) {
    const startedAt = Date.now();

    // 先挂错误监听：客户端可能在任何时刻断开，晚挂一步就是一个未捕获的 error 事件
    res.on('error', (error) => log.debug(t('proxy.log.resStreamError', { message: error.message })));
    req.on('error', (error) => log.debug(t('proxy.log.reqStreamError', { message: error.message })));

    let url = null;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      // Host 头非法时 new URL 会抛 ERR_INVALID_URL，而它抛在 http 服务器的回调里
      stats.errors += 1;
      stats.handledErrors += 1;
      log.warn(t('proxy.log.badRequestTarget', { url: JSON.stringify(req.url), host: JSON.stringify(req.headers.host) }));
      respondJson(res, 400, {
        error: {
          type: 'bad_request_target',
          message: t('proxy.err.badRequestTarget', { url: req.url, host: JSON.stringify(req.headers.host) }),
        },
      });
      return;
    }

    if (url.pathname.startsWith(LOCAL_PREFIX)) {
      if (handleLocal(req, res, url)) return;
      // 错误体必须带 type：客户端按 type 分支处理，只给一句 message 的话
      // 客户端只能靠猜——「404 的 body 长得不一样」这种约定不是约定。
      respondJson(res, 404, {
        error: {
          type: 'unknown_endpoint',
          message: t('proxy.err.unknownEndpoint', { pathname: url.pathname }),
        },
      });
      return;
    }

    const headersLower = new Map();
    for (const [key, value] of Object.entries(req.headers)) {
      headersLower.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value);
    }

    const bodyPromise = config.request.bufferBody
      ? readBody(req, config.request.maxBodyBytes).then(
          (buffer) => ({ buffer }),
          (error) => ({ error }),
        )
      : Promise.resolve({ buffer: null });

    bodyPromise
      .then(async ({ buffer, error }) => {
        if (error) {
          stats.errors += 1;
          const tooLarge = error.code === 'E_TOO_LARGE';
          log.warn(t('proxy.log.readBodyFailed', { method: req.method, url: req.url, message: error.message }));
          respondJson(res, tooLarge ? 413 : 400, {
            error: {
              type: tooLarge ? 'request_too_large' : 'request_body_incomplete',
              message: error.message,
            },
          });
          // 请求体超限时读侧已经暂停，socket 不能一直挂着——
          // 答复发出去之后立刻断开。
          if (tooLarge) {
            try {
              res.on('finish', () => req.destroy());
            } catch {
              /* ignore */
            }
          }
          return;
        }

        // ---- 解析请求体 ----
        const contentType = (headersLower.get('content-type') || '').toLowerCase();
        let parsedBody = null;
        if (buffer && buffer.length && contentType.includes('json')) {
          try {
            const candidate = JSON.parse(buffer.toString('utf8'));
            if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsedBody = candidate;
          } catch {
            parsedBody = null;
          }
        }

        // ---- 会话解析 ----
        const headersObject = Object.fromEntries(headersLower);
        const session = resolveSession({ headers: headersObject, body: parsedBody, config, store });

        // ---- 组装模板上下文 ----
        const context = createContext({
          session: {
            id: session.id,
            count: session.count,
            requestId: session.requestId,
            key: session.key,
            source: session.source,
          },
          model: typeof parsedBody?.model === 'string' ? parsedBody.model : '',
          path: req.url,
          method: req.method,
          header: headersObject,
          query: Object.fromEntries(url.searchParams),
        });

        // ---- 重写模型名 / 路由分桶 / 变换 / 注入请求体参数 ----
        let outBuffer = buffer;
        let modelNote = '';
        let routeNote = '';
        let protocolNote = '';
        let protocolInfo = null; // 非空 = 请求被转写，响应要按 from -> to 转回来
        let upstreamNote = '';
        const bodyChanges = [];

        // 最终的上游与路径。默认走旧的 config.upstream，
        // 命中上游池时会被替换成 provider 的连接信息与端点。
        let targetUpstream = upstream;
        let targetPath = rewritePath(req.url, config.request.pathRewrite);
        let targetPathReplaced = false; // 协议互转 / 上游池替换过路径（那些路径自带前缀）
        let targetProvider = null;
        let targetProviderName = null;

        if (parsedBody) {
          // 客户端要不要流式。必须在任何协议转换**之前**取：
          // Gemini 的流式是靠路径上的 :streamGenerateContent 表达的，
          // 而 chat→gemini 转换会把 stream 挪到 body 的别处。
          const clientStream = parsedBody.stream === true;

          const modelResult = rewriteModel(parsedBody, config.model, { logger: log });
          if (modelResult.changed) {
            modelNote = ` model=${modelResult.from}->${modelResult.to}`;
            context.model = modelResult.to;
          }
          if (modelResult.unmappedAlias && config.model.warnUnmapped !== false) {
            if (warnedModels.size >= WARNED_MODELS_MAX) warnedModels.clear();
            if (!warnedModels.has(modelResult.from)) {
              warnedModels.add(modelResult.from);
              log.warn(
                t('proxy.log.unmappedModelAlias', {
                  alias: modelResult.from,
                  prefix: modelResult.strippedPrefix,
                  resolved: modelResult.to,
                }),
              );
            }
          }

          // 路由分桶。判定用「客户端原始名」与「解析后名字」两个候选，
          // 因为用户写 modelPrefix 时心里想的可能是 proxy-think 也可能是 glm-5.3。
          const route = resolveRoute(
            {
              path: req.url,
              method: req.method,
              body: parsedBody,
              byteLength: buffer ? buffer.length : 0,
              clientModel: modelResult.from,
              resolvedModel: modelResult.to,
            },
            config.router,
          );
          const bucket = getBucket(config.router, route.bucket);
          routeNote = ` route=${route.bucket}${route.source === 'default' ? '' : `(${route.source})`}`;
          if (route.difficulty) routeNote += `[${route.difficulty}:${route.score ?? 0}]`;

          // 桶指定的模型覆盖。放在注入之前，这样 {{model}} 模板看到的是最终名字。
          const override = applyBucketModel(parsedBody, bucket, config.model);
          if (override.changed) {
            context.model = override.to;
            modelNote = ` model=${override.from}->${override.to}(bucket:${route.bucket})`;
          }

          // ---- 选上游（v0.3.0）。这一步必须在协议互转之前：
          //      上游决定了用哪套 wire 协议，也决定了往哪个 host 发。 ----
          const poolEnabled = upstreamPool?.enabled !== false;
          if (poolEnabled) {
            const picked = resolvePoolUpstream({
              model: typeof parsedBody.model === 'string' ? parsedBody.model : '',
              clientModel: modelResult.from,
              bucketUpstream: bucket.upstream,
              upstreamConfig: upstreamPool,
            });
            if (picked.missing) {
              // 池里点名了但没这个 provider —— 报错比默默发去默认上游强
              log.warn(t('proxy.log.upstreamMissing', { name: picked.name }));
            } else if (picked.provider) {
              targetProvider = picked.provider;
              targetProviderName = picked.name;
              const conn = parseProviderBaseUrl(picked.provider.baseUrl);
              if (conn) {
                targetUpstream = {
                  protocol: conn.protocol,
                  host: conn.host,
                  port: conn.port,
                  hostHeader: conn.hostHeader,
                  basePath: conn.basePath,
                };
              }
              upstreamNote = ` upstream=${picked.name}(${picked.source})`;
            }
          }

          // 变换：全局 enabled + 命中桶挂载的，按顺序执行
          const transformerNames = composeTransformers(config.transformers, bucket);
          if (transformerNames.length) {
            const transformed = applyTransformers(parsedBody, transformerNames, {
              options: config.transformers.options,
            });
            if (transformed.changes.length) bodyChanges.push(...transformed.changes);
            // 配置校验已经拦过拼写错误，这里再兜一次：跳过即等于静默失效，必须留痕
            for (const name of transformed.skipped) {
              log.warn(t('proxy.log.transformerSkipped', { name, bucket: route.bucket }));
            }
          }

          const bodyResult = applyBodyInject(parsedBody, config.inject, context);
          if (bodyResult.changed) bodyChanges.push(...bodyResult.changes);

          // 最终要发给上游的模型名。在协议互转**之前**取——
          // chat→gemini 转换会把 model 从 body 里挪走（它在上游路径上），
          // 那时候就再也取不到了。
          const finalModel = typeof parsedBody.model === 'string' ? parsedBody.model : '';

          // ---- 协议互转（v0.2.2）。刻意放在最后：变换与注入针对的是客户端
          //      协议下的字段，整体转成目标协议必须在所有字段级操作完成之后。
          //      转换返回全新对象，parsedBody 换成转换结果再统一重算 outBuffer。 ----
          const sourceProtocol = detectProtocol(url.pathname);
          if (sourceProtocol && config.protocol && typeof config.protocol === 'object') {
            const protoRoute = resolveProtocolRoute(
              {
                clientModel: modelResult.from,
                resolvedModel: typeof parsedBody.model === 'string' ? parsedBody.model : '',
              },
              config.protocol,
            );
            if (protoRoute.target && protoRoute.target !== sourceProtocol) {
              try {
                const converted = convertRequestBody(parsedBody, sourceProtocol, protoRoute.target, {});
                if (converted.changed && converted.body && typeof converted.body === 'object') {
                  const hitRoute =
                    protoRoute.index != null ? (config.protocol.routes || [])[protoRoute.index] : null;
                  const upstreamPath = upstreamPathFor(protoRoute.target, config.protocol, hitRoute?.path);
                  if (upstreamPath) {
                    targetPath = upstreamPath;
                    targetPathReplaced = true;
                  }
                  bodyChanges.push(`protocol:${sourceProtocol}->${protoRoute.target}`);
                  parsedBody = converted.body;
                  // 响应侧要按 target -> source 转回来
                  protocolInfo = { from: protoRoute.target, to: sourceProtocol };
                }
              } catch (error) {
                // 互转失败就按原样转发：转换层绝不变成新的故障面
                log.warn(
                  t('proxy.log.protocolFailed', {
                    from: sourceProtocol,
                    to: protoRoute.target,
                    message: error.message,
                  }),
                );
              }
            }
          }

          // ---- 上游池的 wire 协议（v0.3.0）。provider 知道自己说什么协议，
          //      按模型挑（Copilot 的 gpt-5 家族走 responses，其余走 chat）。
          //      这一层在协议互转**之后**：provider 的 wire 是硬约束，
          //      客户端说什么协议都得迁就上游。 ----
          if (targetProvider) {
            const wire = resolveWire(targetProvider, typeof parsedBody.model === 'string' ? parsedBody.model : '');

            // 端点路径取自 provider 自己的 paths 表（而不是 config.protocol.paths）：
            // provider 是「发到哪」的决定者，它的路径表才权威。
            // 模型名与流式意图都取自**转换前**的值 —— chat→gemini 转换会把
            // model 挪到路径上、body 里就不再有了。
            const providerPath = poolPathFor(targetProvider, wire.wire, {
              model: finalModel,
              stream: clientStream,
            });
            if (providerPath) {
              const prefix = targetUpstream.basePath ? `${targetUpstream.basePath.replace(/\/+$/, '')}` : '';
              targetPath = `${prefix}${providerPath}`;
              targetPathReplaced = true;
            }

            // 请求体当前所处的协议：
            //   - v0.2.2 互转过 → protocolInfo.from（body 已经是那个形状）
            //   - 没互转过     → 客户端自己说的那个（sourceProtocol）
            // provider 的 wire 是硬约束：两者不等就把 body 转过去，
            // 响应侧再按 { from: wire, to: 客户端协议 } 转回来。
            const bodyProtocol = protocolInfo ? protocolInfo.from : sourceProtocol;
            const clientProtocol = protocolInfo ? protocolInfo.to : sourceProtocol;

            if (bodyProtocol && bodyProtocol !== wire.wire) {
              try {
                const converted = convertRequestBody(parsedBody, bodyProtocol, wire.wire, {});
                if (converted.changed && converted.body && typeof converted.body === 'object') {
                  bodyChanges.push(`protocol:${bodyProtocol}->${wire.wire}`);
                  parsedBody = converted.body;
                  protocolInfo = { from: wire.wire, to: clientProtocol };
                }
              } catch (error) {
                // 互转失败就按原样转发：转换层绝不变成新的故障面
                log.warn(
                  t('proxy.log.protocolFailed', {
                    from: bodyProtocol,
                    to: wire.wire,
                    message: error.message,
                  }),
                );
              }
            } else if (!bodyProtocol) {
              // 认不出客户端用什么协议 → body 没法转。上游会自己回一个
              // 「看不懂的请求体」，比在这里猜一个协议强。
              log.warn(
                t('proxy.log.protocolUnknown', {
                  upstream: targetProviderName,
                  wire: wire.wire,
                  path: req.url,
                }),
              );
            }
            upstreamNote += ` wire=${wire.wire}(${wire.source})`;
          }

          if (modelResult.changed || override.changed || bodyChanges.length) {
            // 改了 body 就必须重算长度，交给 http 模块自动处理
            outBuffer = Buffer.from(JSON.stringify(parsedBody), 'utf8');
          }
          if (protocolInfo) {
            // 转换后上游必须用明文回包：gzip 的 SSE 没法按事件切分
            protocolNote = ` proto=${protocolInfo.from}->${protocolInfo.to}`;
          }
        }

        // ---- 拼 basePath 前缀 ----
        // 协议互转与上游池都用**绝对路径**替换了 targetPath（那两条路径自带前缀），
        // 只有原样转发时才需要在这里补 upstream.basePath。
        if (targetUpstream.basePath && !targetPathReplaced) {
          targetPath = `${targetUpstream.basePath.replace(/\/+$/, '')}${
            targetPath.startsWith('/') ? targetPath : `/${targetPath}`
          }`;
        }

        // ---- 组装上游请求头 ----
        const outHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
          const lower = key.toLowerCase();
          if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'content-length') continue;
          if ((config.request.dropHeaders || []).includes(lower)) continue;
          if (!config.request.forwardClientSessionHeaders && config.session.headerNames.includes(lower)) continue;
          outHeaders[key] = value;
        }

        const incomingUA = headersLower.get('user-agent');
        if (shouldReplaceUserAgent(incomingUA, config)) {
          if (config.userAgent) outHeaders['user-agent'] = config.userAgent;
        } else if (incomingUA) {
          outHeaders['user-agent'] = incomingUA;
        }

        Object.assign(outHeaders, buildInjectHeaders(config.inject, context, headersLower));

        // ---- 上游池的请求头与凭据（v0.3.0）----
        if (targetProvider) {
          // provider 的固定头（Copilot 的必需头等）
          for (const [key, value] of Object.entries(providerHeaders(targetProvider))) {
            outHeaders[key] = value;
          }
          // 凭据：值在运行时现取，绝不从配置读、绝不进日志
          try {
            await applyProviderCredential(outHeaders, targetProvider, { log, copilotSession });
          } catch (error) {
            stats.errors += 1;
            log.error(t('proxy.log.credentialFailed', { upstream: targetProviderName, message: error.message }));
            respondJson(res, 502, {
              error: {
                type: 'proxy_credential_error',
                message: t('proxy.err.credentialFailed', { upstream: targetProviderName, message: error.message }),
              },
            });
            return;
          }
        }

        // 协议互转后上游必须用明文回包：gzip 的 SSE 没法按事件边界切分
        if (protocolInfo) outHeaders['accept-encoding'] = 'identity';

        // Host 头指向真正要发往的那个上游
        outHeaders.host = targetUpstream.hostHeader;

        log.info(
          `[req] ${req.method} ${req.url} | session=${session.id} req=${session.requestId} source=${session.source} ` +
            `sessions=${store.size} auth=${headersLower.has('authorization') ? 'present' : 'MISSING'}` +
            `${modelNote}${routeNote}${protocolNote}${upstreamNote}${bodyChanges.length ? ` body=${bodyChanges.join('|')}` : ''}`,
        );
        log.debug(`[req-headers] ${JSON.stringify(outHeaders, null, 0)}`);

        // ---- 发起上游请求 ----
        const transport = targetUpstream.protocol === 'https' ? https : http;
        const targetAgent = getAgent(targetUpstream.protocol);
        let proxyReq;
        try {
          proxyReq = transport.request(
            {
              protocol: `${targetUpstream.protocol}:`,
              host: targetUpstream.host,
              port: targetUpstream.port,
              method: req.method,
              path: targetPath,
              headers: outHeaders,
              agent: targetAgent,
            },
            (proxyRes) =>
              handleUpstreamResponse({ proxyRes, res, req, session, startedAt, targetPath, protocolInfo }),
          );
        } catch (error) {
          // 请求头含非法字符、目标路径未转义等情况会让 transport.request 同步抛错
          stats.errors += 1;
          log.error(t('proxy.log.buildUpstreamFailed', { method: req.method, url: req.url, targetPath, message: error.message }));
          respondJson(res, 502, {
            error: {
              type: 'proxy_request_build_error',
              message: t('proxy.err.buildUpstream', { message: error.message }),
              upstream: `${targetUpstream.protocol}://${targetUpstream.hostHeader}${targetPath}`,
            },
          });
          return;
        }

        stats.bytesIn += outBuffer ? outBuffer.length : 0;

        proxyReq.setTimeout(config.request.timeoutMs, () => {
          proxyReq.destroy(new Error(t('proxy.err.upstreamTimeout', { timeoutMs: config.request.timeoutMs })));
        });

        proxyReq.on('error', (proxyError) => {
          stats.errors += 1;
          log.error(t('proxy.log.upstreamFailed', {
            method: req.method,
            url: req.url,
            targetPath,
            message: proxyError.message,
          }));
          if (!res.headersSent) {
            respondJson(res, 502, {
              error: {
                type: 'proxy_upstream_error',
                message: t('proxy.err.upstreamUnreachable', {
                origin: `${upstream.protocol}://${upstream.hostHeader}`,
                message: proxyError.message,
              }),
                upstream: `${upstream.protocol}://${upstream.hostHeader}${targetPath}`,
              },
            });
          } else {
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
          }
        });

        req.on('aborted', () => proxyReq.destroy(new Error(t('proxy.err.clientAborted'))));

        try {
          if (outBuffer && outBuffer.length) proxyReq.write(outBuffer);
          proxyReq.end();
        } catch (error) {
          stats.errors += 1;
          log.error(t('proxy.log.writeUpstreamFailed', { message: error.message }));
          proxyReq.destroy(error);
        }
      })
      .catch((error) => {
        // 兜住回调里任何没被内层 try 覆盖的抛出，避免变成 unhandledRejection
        stats.errors += 1;
        stats.handledErrors += 1;
        log.error(
          t('proxy.log.requestFailed', {
            method: req.method,
            url: req.url,
            detail: error?.stack || error,
          }),
        );
        respondJson(res, 500, {
          error: { type: 'proxy_internal_error', message: t('proxy.err.internal', { message: error?.message || error }) },
        });
      });
  }

  /** 上游响应回来之后的处理，单独成函数以便整体兜错。 */
  function handleUpstreamResponse({ proxyRes, res, req, session, startedAt, targetPath, protocolInfo = null }) {
    const status = proxyRes.statusCode || 502;
    const rawHeaders = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      rawHeaders[key] = value;
    }
    rawHeaders['x-llm-session-proxy-session'] = session.id || 'disabled';
    if (session.requestId) rawHeaders['x-llm-session-proxy-request'] = session.requestId;

    const resHeaders = sanitizeResponseHeaders(rawHeaders, (key) =>
      log.warn(t('proxy.log.upstreamHeaderDropped', { key })),
    );

    let captured = Buffer.alloc(0);
    let received = 0;
    const capture = (chunk) => {
      received += chunk.length;
      stats.bytesOut += chunk.length;
      if (captured.length < ERROR_CAPTURE_BYTES) {
        captured = Buffer.concat([captured, chunk.subarray(0, ERROR_CAPTURE_BYTES - captured.length)]);
      }
    };

    proxyRes.on('error', (streamError) => {
      log.warn(t('proxy.log.upstreamStreamError', { message: streamError.message }));
      try {
        if (res.writableEnded) return;
        if (!res.headersSent) {
          respondJson(res, 502, { error: { type: 'proxy_upstream_stream_error', message: streamError.message } });
        } else {
          res.destroy();
        }
      } catch {
        /* ignore */
      }
    });

    // ---- 响应侧协议互转的判定 ----
    // 错误体（4xx/5xx）永不转写：上游的错误结构只有它自己能解释，与请求侧约定一致。
    //
    // from === to 时同样不转写：那是恒等变换，上游回的就是客户端要的原样。
    // 之所以要显式挡一道，是因为转码器对 from === to 是**直接抛错**的
    // （见 src/stream.js），而这个判定落在 http 的 'response' 事件回调里——
    // 没有任何人接得住，异常会变成 uncaughtException，整个进程直接消失。
    // 这种组合真实存在：协议路由把 chat 转成 messages，上游池的 wire 又要求 chat，
    // 两次互转正好绕回客户端本来说的那套协议。
    const proto = protocolInfo && protocolInfo.from !== protocolInfo.to && status < 400 ? protocolInfo : null;
    const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
    const convertJson = Boolean(proto && contentType.includes('json'));
    const convertSse = Boolean(proto && contentType.includes('text/event-stream'));
    if (proto && !convertJson && !convertSse) {
      // 请求被转写了，但上游回的既不是 SSE 也不是 JSON——只能原样透传，留痕
      log.debug(t('proxy.log.protocolStreamFallback', { status }));
    }

    if (config.response.stream) {
      if (convertSse) {
        // 流式转码：事件级别边收边转。content-length 不再有意义，交给 chunked。
        delete resHeaders['content-length'];
        if (!writeResponseHead(res, status, proxyRes.statusMessage, resHeaders)) {
          proxyRes.destroy();
          return;
        }
        if (res.socket) res.socket.setNoDelay(true);
        const transcoder = createStreamTranscoder({
          from: proto.from,
          to: proto.to,
          write: (text) => {
            try {
              if (!res.writableEnded && !res.destroyed) res.write(text);
            } catch {
              /* 客户端可能已断开，吞掉 */
            }
          },
        });
        let transcodeFailed = false;
        proxyRes.on('data', (chunk) => {
          capture(chunk);
          if (transcodeFailed) return;
          try {
            transcoder.push(chunk);
          } catch (error) {
            // 转码器在事件回调里抛错，没人接得住 —— 异常会逃出去变成
            // uncaughtException，整个进程直接消失。
            // 与下面的 transcoder.end() 同一个处理：记名，然后把这一条流收掉。
            transcodeFailed = true;
            log.warn(t('proxy.log.protocolFailed', { from: proto.from, to: proto.to, message: error.message }));
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
          }
        });
        proxyRes.on('end', () => {
          try {
            transcoder.end();
          } catch (error) {
            log.warn(t('proxy.log.protocolFailed', { from: proto.from, to: proto.to, message: error.message }));
          }
          try {
            if (!res.writableEnded) res.end();
          } catch {
            /* ignore */
          }
        });
        res.on('close', () => {
          if (!res.writableEnded) proxyRes.destroy();
        });
      } else if (convertJson) {
        // JSON 响应的转写只能整包缓冲后再改写
        const chunks = [];
        proxyRes.on('data', (chunk) => {
          capture(chunk);
          chunks.push(chunk);
        });
        proxyRes.on('end', () => {
          try {
            let payload = Buffer.concat(chunks);
            try {
              const parsed = JSON.parse(payload.toString('utf8'));
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = Buffer.from(
                  JSON.stringify(convertResponseJson(parsed, proto.from, proto.to).payload),
                  'utf8',
                );
              }
            } catch {
              /* 不是合法 JSON 就原样透传 */
            }
            resHeaders['content-length'] = String(payload.length);
            if (!writeResponseHead(res, status, proxyRes.statusMessage, resHeaders)) return;
            res.end(payload);
          } catch (error) {
            stats.errors += 1;
            log.error(t('proxy.log.bufferWriteFailed', { message: error.message }));
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
          }
        });
      } else {
        if (!writeResponseHead(res, status, proxyRes.statusMessage, resHeaders)) {
          proxyRes.destroy();
          return;
        }
        if (res.socket) res.socket.setNoDelay(true);
        proxyRes.on('data', capture);
        try {
          proxyRes.pipe(res);
        } catch (error) {
          log.warn(t('proxy.log.pipeFailed', { message: error.message }));
          proxyRes.destroy();
          res.destroy();
        }
        res.on('close', () => {
          if (!res.writableEnded) proxyRes.destroy();
        });
      }
    } else {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        capture(chunk);
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        try {
          let payload = Buffer.concat(chunks);
          if (convertSse) {
            // 非流式模式下也照转：整包喂给转码器，一次吐完
            const parts = [];
            const transcoder = createStreamTranscoder({
              from: proto.from,
              to: proto.to,
              write: (text) => parts.push(Buffer.from(text, 'utf8')),
            });
            transcoder.push(payload);
            transcoder.end();
            payload = Buffer.concat(parts);
          } else if (convertJson) {
            try {
              const parsed = JSON.parse(payload.toString('utf8'));
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                payload = Buffer.from(
                  JSON.stringify(convertResponseJson(parsed, proto.from, proto.to).payload),
                  'utf8',
                );
              }
            } catch {
              /* 原样透传 */
            }
          }
          // 读到的就是压缩后的完整字节，所以只修正长度，content-encoding 必须保留
          resHeaders['content-length'] = String(payload.length);
          if (!writeResponseHead(res, status, proxyRes.statusMessage, resHeaders)) return;
          res.end(payload);
        } catch (error) {
          stats.errors += 1;
          log.error(t('proxy.log.bufferWriteFailed', { message: error.message }));
          try {
            res.destroy();
          } catch {
            /* ignore */
          }
        }
      });
    }

    proxyRes.on('end', () => {
      stats.requests += 1;
      if (status >= 400) {
        stats.errors += 1;
        log.error(
          `[upstream-error] ${status} ${req.method} ${targetPath} | ${captured
            .toString('utf8')
            .replace(/\s+/g, ' ')
            .slice(0, 800)}`,
        );
      }
      log.info(
        `[res] ${status} ${req.method} ${req.url} | session=${session.id} ${formatBytes(received)} ` +
          `${Date.now() - startedAt}ms stream=${config.response.stream}` +
          `${proto ? ` proto=${proto.from}->${proto.to}` : ''}`,
      );
    });
  }

  /**
   * 给请求头装上 provider 的凭据。
   *
   * 值在运行时现取，**绝不从配置文件读、绝不进日志**：
   * - Copilot：GitHub token 直连（默认），或换 session token（auth.tokenMode: "session"）；
   * - 其余 provider：从环境变量或命令取 API key。
   *
   * 三种情况不加凭据头，都不算错：
   * - provider 压根没配 auth —— 本地 Ollama / LM Studio 这类端点不需要 key；
   * - 配了 auth 但环境变量里没值 —— 放行，让上游回它自己的 401，
   *   比在这里猜「用户是不是漏配了」要准。
   *
   * 但 Copilot 是例外：它的凭据走内置的 GitHub token 链，与 provider.auth
   * 无关。没配 auth 的 Copilot provider **不代表**「这是一个免鉴权端点」——
   * 放行只会让上游回一个语焉不详的 401，不如在这里说清楚「没拿到 Copilot 凭据」。
   */
  async function applyProviderCredential(headers, provider, { log: logger2, copilotSession: sessionMgr }) {
    const spec = credentialHeaderSpec(provider);

    if (provider.type === 'copilot') {
      // Copilot 必须有凭据：没有它上游只会回一个语焉不详的 401。
      const auth = provider.auth && typeof provider.auth === 'object' ? provider.auth : {};
      const session = await sessionMgr.get({
        envNames: typeof auth.env === 'string' ? auth.env.split(',').map((s) => s.trim()).filter(Boolean) : [],
        command: typeof auth.command === 'string' ? auth.command : null,
        allowCommand: auth.allowCommand !== false,
        // direct（默认）把 GitHub token 直接发给 Copilot API；
        // session 才去 copilot_internal/v2/token 换短命 token。
        tokenMode: auth.tokenMode,
        // 设备流登录需要人参与，所以只有 provider 明确写了 auth.deviceFlow 才启用。
        allowDeviceFlow: auth.deviceFlow === true,
        // 设备码要给人看：把它写到控制台与日志里（只有码和地址，没有 token）。
        onDeviceCode: auth.deviceFlow === true
          ? ({ userCode, verificationUri }) => {
            logger2.info(t('copilot.log.deviceCode', { code: userCode, url: verificationUri }));
          }
          : null,
      });
      headers[spec.header] = `${spec.prefix}${session.token}`;
      return;
    }

    const auth = provider.auth;
    if (!auth || typeof auth !== 'object') return;

    const resolved = await resolveApiKey(provider);
    if (!resolved) {
      logger2?.debug(t('copilot.log.noApiKey', { upstream: provider.name || provider.type }));
      return;
    }
    headers[spec.header] = `${spec.prefix}${resolved.value}`;
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0;

  // 客户端发了畸形请求（非法请求行/头）时 Node 会发 clientError。
  // 没有监听者时它会用自己的默认处理，这里显式接管并保证 socket 一定被关掉。
  server.on('clientError', (error, socket) => {
    log.debug(t('proxy.log.clientParseFailed', { code: error?.code || error?.message }));
    // 复刻 Node 默认处理的语义：头太大回 431，其余畸形请求回 400
    const overflow = error?.code === 'HPE_HEADER_OVERFLOW';
    const status = overflow
      ? 'HTTP/1.1 431 Request Header Fields Too Large'
      : 'HTTP/1.1 400 Bad Request';
    try {
      if (socket.destroyed || !socket.writable) return;
      socket.end(`${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  return {
    server,
    store,
    upstream,
    stats,
    config,
    agent,
    listen(port = config.listen.port, host = config.listen.host) {
      // 自动分配的端口（port === 0）有可能被 OS 扔到 WHATWG 禁用端口上
      // （6000 / 6666 / 10080 …）。那种端口 Node 绑得上，浏览器和 fetch 客户端
      // 却按规范直接拒绝——服务起来了但谁都连不上。用户没点名要哪个端口，
      // 所以这里换一个能用的；用户显式写下的端口则原样尊重，由 doctor 提醒。
      return listenUntilUsablePort(server, {
        port,
        host,
        onAbandon: (rejected) => log.debug(t('proxy.log.autoPortRetry', { port: rejected })),
        onGiveUp: (forced) => log.warn(t('proxy.log.autoPortForbidden', { port: forced })),
      }).then((address) => {
        // 启动成功后挂常驻错误处理：监听之后再冒出来的 error 事件
        // 若无人接管，一样会直接终止进程
        server.on('error', (error) => {
          stats.errors += 1;
          log.error(t('proxy.log.serverError', { detail: error?.stack || error?.message || error }));
        });
        return address;
      });
    },
    close() {
      // 上游池可能有多个连接池，全部销毁
      for (const cached of agents.values()) cached.destroy();
      agents.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    guard,
  };
}
