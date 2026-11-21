/**
 * 本地 Prometheus 指标收集器（v0.4）。
 *
 * 约束：零依赖、纯内存、只追加计数；observe() 全程吞错，指标永远不能影响转发。
 * 标签只来自配置里的 provider 名 / HTTP 状态码 / usage 来源，仍按不可信输入转义。
 *
 * 注意：这里记录的是代理观察到的**整段请求耗时**（从收到请求到响应结束），
 * 不是「代理额外引入了多少延迟」——后者需要一个没有代理的基线，本地无法凭空测出。
 */

export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function label(value) {
  return String(value ?? 'unknown')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function metric(lines, name, type, help, series) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(...series);
}

function num(value) {
  return Number.isFinite(value) ? String(value) : '0';
}

export class MetricsCollector {
  constructor({ startedAt = Date.now(), getSessions = null, buckets = LATENCY_BUCKETS_MS } = {}) {
    this.startedAt = startedAt;
    this.getSessions = typeof getSessions === 'function' ? getSessions : () => ({ active: 0, hits: 0, misses: 0 });
    this.buckets = [...buckets].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
    this.requests = 0;
    this.byStatus = new Map();
    this.byUpstream = new Map();
    this.bySource = new Map();
    this.failures = new Map();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.latency = { count: 0, sum: 0, buckets: new Map(this.buckets.map((b) => [b, 0])) };
    this.tokens = { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  }

  bump(map, key, amount = 1) {
    map.set(key, (map.get(key) || 0) + amount);
  }

  observe(meta = {}) {
    try {
      this.requests += 1;
      const status = Number.isFinite(Number(meta.status)) ? Number(meta.status) : 0;
      const upstream = meta.upstream || meta.source || 'upstream';
      const source = meta.source || 'upstream';
      this.bump(this.byStatus, String(status));
      this.bump(this.byUpstream, String(upstream));
      this.bump(this.bySource, String(source));
      if (meta.error || status >= 400) {
        this.bump(this.failures, meta.error ? String(meta.error) : `http_${status}`);
      }
      const bytesIn = Number(meta.bytesIn);
      const bytesOut = Number(meta.bytesOut);
      if (Number.isFinite(bytesIn)) this.bytesIn += bytesIn;
      if (Number.isFinite(bytesOut)) this.bytesOut += bytesOut;

      const duration = Number(meta.durationMs);
      if (Number.isFinite(duration) && duration >= 0) {
        this.latency.count += 1;
        this.latency.sum += duration;
        for (const [bucket, count] of this.latency.buckets) {
          if (duration <= bucket) this.latency.buckets.set(bucket, count + 1);
        }
      }

      const usage = meta.usage && typeof meta.usage === 'object' ? meta.usage : null;
      if (usage) {
        this.tokens.prompt += Number(usage.promptTokens) || 0;
        this.tokens.completion += Number(usage.completionTokens) || 0;
        this.tokens.cacheRead += Number(usage.cacheReadTokens) || 0;
        this.tokens.cacheWrite += Number(usage.cacheWriteTokens) || 0;
        this.tokens.reasoning += Number(usage.reasoningTokens) || 0;
      }
    } catch {
      /* 指标故障绝不影响请求 */
    }
  }

  /** 直接从 SessionStore 取快照，不缓存——本地端点每次来读都是当前值。 */
  sessionStats() {
    try {
      const value = this.getSessions();
      return {
        active: Number(value?.active) || 0,
        hits: Number(value?.hits) || 0,
        misses: Number(value?.misses) || 0,
      };
    } catch {
      return { active: 0, hits: 0, misses: 0 };
    }
  }

  render() {
    const lines = [];
    const counterSeries = (map, metricName, labelName) =>
      [...map.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, value]) => `llm_session_proxy_${metricName}_total{${labelName}="${label(key)}"} ${num(value)}`);

    metric(lines, 'llm_session_proxy_upptime_seconds', 'gauge', 'Process uptime in seconds.', [
      `llm_session_proxy_upptime_seconds ${num(Math.round((Date.now() - this.startedAt) / 1000))}`,
    ]);
    metric(lines, 'llm_session_proxy_requests_total', 'counter', 'Total proxied requests.', [
      `llm_session_proxy_requests_total ${num(this.requests)}`,
    ]);
    metric(lines, 'llm_session_proxy_requests_by_status_total', 'counter', 'Requests by HTTP status code.', counterSeries(this.byStatus, 'requests_by_status', 'status'));
    metric(lines, 'llm_session_proxy_requests_by_upstream_total', 'counter', 'Requests by selected upstream.', counterSeries(this.byUpstream, 'requests_by_upstream', 'upstream'));
    metric(lines, 'llm_session_proxy_requests_by_source_total', 'counter', 'Requests by usage source.', counterSeries(this.bySource, 'requests_by_source', 'source'));
    metric(lines, 'llm_session_proxy_failures_total', 'counter', 'Failures by reason.', counterSeries(this.failures, 'failures', 'reason'));
    metric(lines, 'llm_session_proxy_bytes_in_total', 'counter', 'Bytes sent to upstreams.', [`llm_session_proxy_bytes_in_total ${num(this.bytesIn)}`]);
    metric(lines, 'llm_session_proxy_bytes_out_total', 'counter', 'Bytes received from upstreams.', [`llm_session_proxy_bytes_out_total ${num(this.bytesOut)}`]);

    const histogram = [];
    for (const bucket of this.buckets) {
      histogram.push(`llm_session_proxy_request_duration_seconds_bucket{le="${bucket / 1000}"} ${num(this.latency.buckets.get(bucket))}`);
    }
    histogram.push(`llm_session_proxy_request_duration_seconds_bucket{le="+Inf"} ${num(this.latency.count)}`);
    histogram.push(`llm_session_proxy_request_duration_seconds_sum ${num(this.latency.sum / 1000)}`);
    histogram.push(`llm_session_proxy_request_duration_seconds_count ${num(this.latency.count)}`);
    metric(lines, 'llm_session_proxy_request_duration_seconds', 'histogram', 'End-to-end request duration observed by the proxy.', histogram);

    const sessions = this.sessionStats();
    metric(lines, 'llm_session_proxy_sessions_active', 'gauge', 'Sessions currently in the local table.', [
      `llm_session_proxy_sessions_active ${num(sessions.active)}`,
    ]);
    metric(lines, 'llm_session_proxy_sessions_hits_total', 'counter', 'Local session-table hits.', [
      `llm_session_proxy_sessions_hits_total ${num(sessions.hits)}`,
    ]);
    metric(lines, 'llm_session_proxy_sessions_misses_total', 'counter', 'Local session-table misses.', [
      `llm_session_proxy_sessions_misses_total ${num(sessions.misses)}`,
    ]);
    metric(lines, 'llm_session_proxy_prompt_tokens_total', 'counter', 'Prompt tokens reported by upstreams.', [`llm_session_proxy_prompt_tokens_total ${num(this.tokens.prompt)}`]);
    metric(lines, 'llm_session_proxy_completion_tokens_total', 'counter', 'Completion tokens reported by upstreams.', [`llm_session_proxy_completion_tokens_total ${num(this.tokens.completion)}`]);
    metric(lines, 'llm_session_proxy_cache_read_tokens_total', 'counter', 'Cache-read tokens reported by upstreams.', [`llm_session_proxy_cache_read_tokens_total ${num(this.tokens.cacheRead)}`]);
    metric(lines, 'llm_session_proxy_cache_write_tokens_total', 'counter', 'Cache-write tokens reported by upstreams.', [`llm_session_proxy_cache_write_tokens_total ${num(this.tokens.cacheWrite)}`]);
    metric(lines, 'llm_session_proxy_reasoning_tokens_total', 'counter', 'Reasoning tokens reported by upstreams.', [`llm_session_proxy_reasoning_tokens_total ${num(this.tokens.reasoning)}`]);

    const basis = this.tokens.prompt + this.tokens.cacheRead;
    metric(lines, 'llm_session_proxy_prompt_cache_reuse_ratio', 'gauge', 'Cache-read tokens / (prompt + cache-read) tokens.', [
      `llm_session_proxy_prompt_cache_reuse_ratio ${basis > 0 ? (this.tokens.cacheRead / basis).toFixed(6) : '0'}`,
    ]);
    return `${lines.join('\n')}\n`;
  }
}

/** 会话前缀检查器：把会话表与按会话的 token 记录拼起来，给出可解释的缓存复用估算。 */
export function inspectSessionPrefixes({ store, entries = [] }) {
  const rows = [];
  bySessionMap(entries).forEach((agg, sessionId) => {
    const key = agg.key || null;
    const prefixHash = key && key.startsWith('k_') ? key : null;
    const basis = agg.prompt + agg.cacheRead;
    const rate = basis > 0 ? agg.cacheRead / basis : 0;
    rows.push({
      sessionId,
      key,
      prefixHash,
      requests: agg.requests,
      promptTokens: agg.prompt,
      cacheReadTokens: agg.cacheRead,
      cacheReadRate: Number(rate.toFixed(4)),
      // 只按形态给提示，不声称知道上游内部实现
      cacheReusable: agg.requests >= 2 || rate > 0 ? 'likely' : 'unknown',
    });
  });
  if (store?.map) {
    for (const [key, record] of store.map.entries()) {
      if (rows.some((row) => row.key === key)) continue;
      rows.push({
        sessionId: record.id,
        key,
        prefixHash: key.startsWith('k_') ? key : null,
        requests: record.count || 0,
        promptTokens: 0,
        cacheReadTokens: 0,
        cacheReadRate: 0,
        cacheReusable: (record.count || 0) >= 2 ? 'likely' : 'unknown',
      });
    }
  }
  rows.sort((a, b) => b.requests - a.requests || String(a.sessionId).localeCompare(String(b.sessionId)));
  return {
    count: rows.length,
    note: 'cacheReusable is a heuristic from local reuse count and upstream cache-read tokens, not a guarantee.',
    items: rows,
  };
}

function bySessionMap(entries) {
  const out = new Map();
  for (const entry of entries || []) {
    const id = entry?.sessionId || entry?.session || '(unknown)';
    if (!out.has(id)) out.set(id, { requests: 0, prompt: 0, cacheRead: 0, key: null });
    const agg = out.get(id);
    agg.requests += 1;
    agg.prompt += Number(entry?.usage?.promptTokens) || 0;
    agg.cacheRead += Number(entry?.usage?.cacheReadTokens) || 0;
    if (!agg.key && entry?.sessionKey) agg.key = entry.sessionKey;
  }
  return out;
}
