/**
 * OTLP/JSON 导出（v0.4）。
 *
 * 默认关闭；只有用户显式给了 http(s) 端点才工作。用 Node 内置 fetch 发一条
 * OTLP/JSON 形态的 log record，不引第三方 SDK、不用 protobuf。
 * 所有失败吞掉：可观测性永远不能把代理弄挂，也不能让请求成功变失败。
 */

function attributes(fields) {
  const out = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } });
    } else if (typeof value === 'boolean') {
      out.push({ key, value: { boolValue: value } });
    } else {
      out.push({ key, value: { stringValue: String(value).slice(0, 512) } });
    }
  }
  return out;
}

export function renderOtlpJson(record, { serviceName = 'llm-session-proxy' } = {}) {
  const ts = typeof record?.ts === 'string' && record.ts ? record.ts : new Date().toISOString();
  const body = record?.event ? `llm-session-proxy ${record.event}` : 'llm-session-proxy request';
  const fields = { ...(record || {}) };
  delete fields.ts;
  delete fields.event;
  const status = Number(fields.status);
  if (Number.isFinite(status)) fields['http.response.status_code'] = status;
  return {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeLogs: [{
        scope: { name: serviceName },
        logRecords: [{
          timeUnixNano: String(Date.parse(ts) || Date.now()) + '000000',
          severityNumber: record?.status >= 400 ? 13 : 9,
          severityText: record?.status >= 400 ? 'ERROR' : 'INFO',
          body: { stringValue: body },
          attributes: attributes(fields),
        }],
      }],
    }],
  };
}

export function createExporter({
  enabled = false,
  endpoint = null,
  headers = {},
  timeoutMs = 2000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const active = enabled === true && typeof endpoint === 'string' && endpoint.trim().length > 0;
  const target = active ? endpoint.trim() : null;
  const extraHeaders = headers && typeof headers === 'object' ? headers : {};
  let dropped = 0;
  let sent = 0;

  return {
    get enabled() { return active; },
    get endpoint() { return target; },
    get dropped() { return dropped; },
    get sent() { return sent; },
    export(record) {
      if (!active || typeof fetchImpl !== 'function') return Promise.resolve(false);
      let payload;
      try {
        payload = JSON.stringify(renderOtlpJson(record));
      } catch {
        dropped += 1;
        return Promise.resolve(false);
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs || 2000)) : null;
      let response;
      try {
        response = fetchImpl(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...extraHeaders },
          body: payload,
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch {
        dropped += 1;
        if (timer) clearTimeout(timer);
        return Promise.resolve(false);
      }
      return Promise.resolve(response)
        .then(async (res) => {
          const ok = Boolean(res && res.ok);
          if (ok) sent += 1;
          else dropped += 1;
          // 消费响应体，避免连接挂住；内容本身不用
          if (res && typeof res.text === 'function') await res.text().catch(() => '');
          return ok;
        })
        .catch(() => {
          dropped += 1;
          return false;
        });
    },
  };
}
