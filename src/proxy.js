import http from 'node:http';
import https from 'node:https';
import { resolveUpstream, shouldReplaceUserAgent } from './config.js';
import { applyBodyInject, buildInjectHeaders, rewriteModel, rewritePath } from './inject.js';
import { resolveSession, SessionStore } from './session.js';
import { createContext } from './template.js';

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

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error(`请求体超过上限 ${maxBytes} 字节`);
        error.code = 'E_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
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
 */
export function createProxyServer({ config, logger }) {
  const store = new SessionStore(config.session);
  const upstream = resolveUpstream(config);
  const stats = { startedAt: Date.now(), requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 };

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

  function handleLocal(req, res, url) {
    if (url.pathname === `${LOCAL_PREFIX}/health` || url.pathname === `${LOCAL_PREFIX}/status`) {
      sendJson(res, 200, {
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
      sendJson(res, 200, { count: items.length, items });
      return true;
    }
    return false;
  }

  function handle(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith(LOCAL_PREFIX)) {
      if (handleLocal(req, res, url)) return;
      sendJson(res, 404, { error: { message: `未知的本地端点: ${url.pathname}` } });
      return;
    }

    res.on('error', (error) => log.debug('[client] 响应流出错（客户端可能已断开）:', error.message));
    req.on('error', (error) => log.debug('[client] 请求流出错:', error.message));

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

    bodyPromise.then(({ buffer, error }) => {
      if (error) {
        stats.errors += 1;
        log.warn(`[req] ${req.method} ${req.url} 读取请求体失败: ${error.message}`);
        sendJson(res, 413, { error: { type: 'request_too_large', message: error.message } });
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
      const proxyReq = transport.request(
        {
          protocol: `${upstream.protocol}:`,
          host: upstream.host,
          port: upstream.port,
          method: req.method,
          path: targetPath,
          headers: outHeaders,
          agent,
        },
        (proxyRes) => {
          const status = proxyRes.statusCode || 502;
          const resHeaders = {};
          for (const [key, value] of Object.entries(proxyRes.headers)) {
            const lower = key.toLowerCase();
            if (HOP_BY_HOP.has(lower)) continue;
            resHeaders[key] = value;
          }
          resHeaders['x-llm-session-proxy-session'] = session.id || 'disabled';
          if (session.requestId) resHeaders['x-llm-session-proxy-request'] = session.requestId;

          let captured = Buffer.alloc(0);
          let received = 0;
          const capture = (chunk) => {
            received += chunk.length;
            stats.bytesOut += chunk.length;
            if (captured.length < ERROR_CAPTURE_BYTES) {
              captured = Buffer.concat([captured, chunk.subarray(0, ERROR_CAPTURE_BYTES - captured.length)]);
            }
          };

          if (config.response.stream) {
            res.writeHead(status, proxyRes.statusMessage, resHeaders);
            if (res.socket) res.socket.setNoDelay(true);
            proxyRes.on('data', capture);
            proxyRes.on('error', (streamError) => {
              log.warn(`[res] 上游响应流中断: ${streamError.message}`);
              res.destroy();
            });
            proxyRes.pipe(res);
            res.on('close', () => {
              if (!res.writableEnded) {
                proxyRes.destroy();
              }
            });
          } else {
            const chunks = [];
            proxyRes.on('data', (chunk) => {
              capture(chunk);
              chunks.push(chunk);
            });
            proxyRes.on('end', () => {
              const payload = Buffer.concat(chunks);
              // 读到的就是压缩后的完整字节，所以只修正长度，content-encoding 必须保留
              resHeaders['content-length'] = String(payload.length);
              res.writeHead(status, proxyRes.statusMessage, resHeaders);
              res.end(payload);
            });
            proxyRes.on('error', (streamError) => {
              log.warn(`[res] 上游响应读取失败: ${streamError.message}`);
              if (!res.headersSent) sendJson(res, 502, { error: { message: streamError.message } });
              else res.destroy();
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
        },
      );

      stats.bytesIn += outBuffer ? outBuffer.length : 0;

      proxyReq.setTimeout(config.request.timeoutMs, () => {
        proxyReq.destroy(new Error(`上游 ${config.request.timeoutMs}ms 未响应，已超时`));
      });

      proxyReq.on('error', (proxyError) => {
        stats.errors += 1;
        log.error(`[proxy-error] ${req.method} ${req.url} -> ${targetPath}: ${proxyError.message}`);
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: {
              type: 'proxy_upstream_error',
              message: `无法连接上游 ${upstream.protocol}://${upstream.hostHeader}: ${proxyError.message}`,
              upstream: `${upstream.protocol}://${upstream.hostHeader}${targetPath}`,
            },
          });
        } else {
          res.destroy();
        }
      });

      req.on('aborted', () => proxyReq.destroy(new Error('客户端中断了请求')));

      if (outBuffer && outBuffer.length) proxyReq.write(outBuffer);
      proxyReq.end();
    });
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0;

  return {
    server,
    store,
    upstream,
    stats,
    config,
    agent,
    listen(port = config.listen.port, host = config.listen.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
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
