import http from 'node:http';
import https from 'node:https';
import { resolveUpstream, shouldReplaceUserAgent } from './config.js';
import { applyBodyInject, buildInjectHeaders, rewriteModel, rewritePath } from './inject.js';
import { resolveSession, SessionStore } from './session.js';
import { createContext } from './template.js';
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
      else if (kept.length !== value.length) onDrop(key);
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
        req.destroy();
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

  const agent =
    upstream.protocol === 'https'
      ? new https.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 30000 })
      : new http.Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 30000 });

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
      respondJson(res, 404, { error: { message: t('proxy.err.unknownEndpoint', { pathname: url.pathname }) } });
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
      .then(({ buffer, error }) => {
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

        // ---- 重写路径 ----
        let targetPath = rewritePath(req.url, config.request.pathRewrite);
        if (upstream.basePath) {
          targetPath = `${upstream.basePath.replace(/\/+$/, '')}${
            targetPath.startsWith('/') ? targetPath : `/${targetPath}`
          }`;
        }

        // ---- 重写模型名 / 注入请求体参数 ----
        let outBuffer = buffer;
        let modelNote = '';
        const bodyChanges = [];
        if (parsedBody) {
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
          const bodyResult = applyBodyInject(parsedBody, config.inject, context);
          if (bodyResult.changed) bodyChanges.push(...bodyResult.changes);
          if (modelResult.changed || bodyResult.changed) {
            // 改了 body 就必须重算长度，交给 http 模块自动处理
            outBuffer = Buffer.from(JSON.stringify(parsedBody), 'utf8');
          }
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

        const hostValue =
          config.upstream.rewriteHost === false ? req.headers.host || upstream.hostHeader : upstream.hostHeader;
        outHeaders.host = hostValue;

        log.info(
          `[req] ${req.method} ${req.url} | session=${session.id} req=${session.requestId} source=${session.source} ` +
            `sessions=${store.size} auth=${headersLower.has('authorization') ? 'present' : 'MISSING'}` +
            `${modelNote}${bodyChanges.length ? ` body=${bodyChanges.join('|')}` : ''}`,
        );
        log.debug(`[req-headers] ${JSON.stringify(outHeaders, null, 0)}`);

        // ---- 发起上游请求 ----
        const transport = upstream.protocol === 'https' ? https : http;
        let proxyReq;
        try {
          proxyReq = transport.request(
            {
              protocol: `${upstream.protocol}:`,
              host: upstream.host,
              port: upstream.port,
              method: req.method,
              path: targetPath,
              headers: outHeaders,
              agent,
            },
            (proxyRes) => handleUpstreamResponse({ proxyRes, res, req, session, startedAt, targetPath }),
          );
        } catch (error) {
          // 请求头含非法字符、目标路径未转义等情况会让 transport.request 同步抛错
          stats.errors += 1;
          log.error(t('proxy.log.buildUpstreamFailed', { method: req.method, url: req.url, targetPath, message: error.message }));
          respondJson(res, 502, {
            error: {
              type: 'proxy_request_build_error',
              message: t('proxy.err.buildUpstream', { message: error.message }),
              upstream: `${upstream.protocol}://${upstream.hostHeader}${targetPath}`,
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
  function handleUpstreamResponse({ proxyRes, res, req, session, startedAt, targetPath }) {
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

    if (config.response.stream) {
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
    } else {
      const chunks = [];
      proxyRes.on('data', (chunk) => {
        capture(chunk);
        chunks.push(chunk);
      });
      proxyRes.on('end', () => {
        try {
          const payload = Buffer.concat(chunks);
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
          `${Date.now() - startedAt}ms stream=${config.response.stream}`,
      );
    });
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
      return new Promise((resolve, reject) => {
        const onStartupError = (error) => {
          server.removeListener('error', onStartupError);
          reject(error);
        };
        server.once('error', onStartupError);
        server.listen(port, host, () => {
          server.removeListener('error', onStartupError);
          // 启动成功后挂常驻错误处理：监听之后再冒出来的 error 事件
          // 若无人接管，一样会直接终止进程
          server.on('error', (error) => {
            stats.errors += 1;
            log.error(t('proxy.log.serverError', { detail: error?.stack || error?.message || error }));
          });
          resolve(server.address());
        });
      });
    },
    close() {
      agent.destroy();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    guard,
  };
}
