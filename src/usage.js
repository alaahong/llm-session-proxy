import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getLang, setLang, t } from './messages.js';

/**
 * 用量统计（v0.4）。
 *
 * 设计约束：
 *   - 零依赖：只有 Node 内置 fs/os/path。
 *   - **不改动转发链路**：usage 从「上游响应的字节副本」里旁路提取，
 *     SSE 按 data: 行增量扫描，JSON 整包解析；客户端拿到的字节不受影响。
 *   - 落盘是 append-only JSONL：坏行跳过，重启后可读，不需要数据库。
 *   - 价格**不硬编码**：usage.prices 由用户自供（每百万 token 单价），
 *     没配价格就只报 token，不猜厂商定价。
 */

export const USAGE_FILE = 'usage.jsonl';
export const DEFAULT_MAX_ENTRIES = 10000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const SSE_BUFFER_LIMIT = 1024 * 1024;

export function usageFilePath(env = process.env, configured = null) {
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());
  const home = typeof env.LSP_HOME === 'string' && env.LSP_HOME.trim()
    ? env.LSP_HOME.trim()
    : path.join(os.homedir(), '.lsp');
  return path.join(path.resolve(home), USAGE_FILE);
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

function firstFinite(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/** 把各家 token 字段归一到同一组键；没有任何 token 字段时返回 null。 */
export function normalizeUsageTokens(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const prompt = firstFinite(raw.prompt_tokens, raw.input_tokens, raw.promptTokenCount);
  const completion = firstFinite(raw.completion_tokens, raw.output_tokens, raw.candidatesTokenCount);
  let total = firstFinite(raw.total_tokens, raw.totalTokenCount);
  if (!total && (prompt || completion)) total = prompt + completion;
  const cacheRead = firstFinite(
    raw.cache_read_input_tokens,
    raw.prompt_tokens_details?.cached_tokens,
    raw.input_tokens_details?.cached_tokens,
    raw.cachedContentTokenCount,
  );
  const cacheWrite = firstFinite(raw.cache_creation_input_tokens, raw.prompt_tokens_details?.cache_write_tokens);
  const reasoning = firstFinite(raw.completion_tokens_details?.reasoning_tokens, raw.output_tokens_details?.reasoning_tokens);
  if (!prompt && !completion && !total && !cacheRead && !cacheWrite && !reasoning) return null;
  return {
    promptTokens: finite(prompt),
    completionTokens: finite(completion),
    totalTokens: finite(total),
    cacheReadTokens: finite(cacheRead),
    cacheWriteTokens: finite(cacheWrite),
    reasoningTokens: finite(reasoning),
  };
}

/**
 * 从一条响应载荷里提取 usage。
 * 自动识别 OpenAI chat / responses、Anthropic messages、Gemini 三种形状；
 * wire 只作为提示，避免同一 payload 里多种字段并存时选错。
 */
export function extractUsage(payload, wire = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  let direct = normalizeUsageTokens(payload.usage);
  if (direct) return direct;

  // Anthropic 把 usage 放在 message_start 的 message 里，SSE 探针会喂完整事件对象
  direct = normalizeUsageTokens(payload.message?.usage);
  if (direct) return direct;

  // Gemini 用 usageMetadata
  direct = normalizeUsageTokens(payload.usageMetadata);
  if (direct) return direct;

  // responses 的 completed 事件：{ type, response: { usage } }
  if (payload.response && typeof payload.response === 'object') {
    direct = normalizeUsageTokens(payload.response.usage);
    if (direct) return direct;
  }

  // chat.completion.chunk 可能把 usage 塞进 choice
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      direct = normalizeUsageTokens(choice?.usage);
      if (direct) return direct;
    }
  }
  return null;
}

/**
 * SSE 增量探针：只从 data: 行里 Parse JSON 并找 usage，不重写、不缓存整条流。
 * 分块边界、CRLF、多事件同块、[DONE] 都按 SSE 常规处理。
 */
export function createUsageProbe() {
  let buffer = '';
  let last = null;
  let sawUsage = false;

  const consumeLine = (line) => {
    const text = line.trim();
    if (!text.startsWith('data:')) return;
    const data = text.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const usage = extractUsage(parsed);
    if (!usage) return;
    // 后到的 usage 覆盖前面的：流式末尾才是最终计数。
    last = usage;
    sawUsage = true;
  };

  return {
    push(chunk) {
      if (sawUsage || !chunk) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > SSE_BUFFER_LIMIT) buffer = buffer.slice(-SSE_BUFFER_LIMIT);
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    },
    end() {
      if (!sawUsage && buffer.trim()) consumeLine(buffer);
      buffer = '';
      return last;
    },
    getUsage() {
      return last;
    },
  };
}

/**
 * 按响应类型选探针：SSE 走事件行扫描，JSON 走尾部缓冲解析。
 * 两种都只读字节副本，不改写、不缓冲整条 SSE 流。
 */
export function createResponseUsageProbe(contentType = '') {
  if (String(contentType).toLowerCase().includes('text/event-stream')) return createUsageProbe();
  let tail = Buffer.alloc(0);
  const LIMIT = 1024 * 1024;
  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > LIMIT) tail = tail.subarray(tail.length - LIMIT);
    },
    end() {
      if (!tail.length) return null;
      try {
        return extractUsage(JSON.parse(tail.toString('utf8')));
      } catch {
        return null;
      }
    },
  };
}

/** 内存里一条记录的形状；多余字段原样保留，汇总只认白名单键。 */
function normalizeEntry(entry, now) {
  if (!entry || typeof entry !== 'object') return null;
  const model = typeof entry.model === 'string' && entry.model ? entry.model : '(unknown)';
  const source = typeof entry.source === 'string' && entry.source ? entry.source : 'upstream';
  const status = Number.isFinite(entry.status) ? entry.status : 0;
  const durationMs = Math.max(0, finite(entry.durationMs));
  const usage = entry.usage && typeof entry.usage === 'object' ? entry.usage : {};
  return {
    ts: typeof entry.ts === 'string' ? entry.ts : new Date(now).toISOString(),
    model,
    source,
    providerType: typeof entry.providerType === 'string' ? entry.providerType : null,
    sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : null,
    sessionKey: typeof entry.sessionKey === 'string' && entry.sessionKey ? entry.sessionKey : null,
    status,
    ok: status >= 200 && status < 400,
    durationMs,
    usage: {
      promptTokens: finite(usage.promptTokens),
      completionTokens: finite(usage.completionTokens),
      totalTokens: finite(usage.totalTokens),
      cacheReadTokens: finite(usage.cacheReadTokens),
      cacheWriteTokens: finite(usage.cacheWriteTokens),
      reasoningTokens: finite(usage.reasoningTokens),
    },
    protocol: typeof entry.protocol === 'string' ? entry.protocol : null,
    error: typeof entry.error === 'string' ? entry.error : null,
    bytesOut: finite(entry.bytesOut),
  };
}

function emptyAgg() {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    clientErrors: 0,
    serverErrors: 0,
    transportErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: 0,
    durations: [],
    cost: 0,
  };
}

function mergeInto(agg, entry, prices, currency) {
  agg.requests += 1;
  if (entry.ok) agg.succeeded += 1;
  else {
    agg.failed += 1;
    if (entry.status >= 400 && entry.status < 500) agg.clientErrors += 1;
    else if (entry.status >= 500) agg.serverErrors += 1;
    else agg.transportErrors += 1;
  }
  agg.promptTokens += entry.usage.promptTokens;
  agg.completionTokens += entry.usage.completionTokens;
  agg.totalTokens += entry.usage.totalTokens;
  agg.cacheReadTokens += entry.usage.cacheReadTokens;
  agg.cacheWriteTokens += entry.usage.cacheWriteTokens;
  agg.reasoningTokens += entry.usage.reasoningTokens;
  agg.durationMs += entry.durationMs;
  agg.durations.push(entry.durationMs);
  agg.cost += entryCost(entry, prices);
  return agg;
}

function priceEntry(prices, model, source) {
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return null;
  const keys = [`${source}:${model}`, model, source, '*'];
  for (const key of keys) {
    const value = prices[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return { input: value, output: value };
  }
  return null;
}

export function entryCost(entry, prices = {}) {
  const price = priceEntry(prices, entry.model, entry.source);
  if (!price) return 0;
  const input = finite(price.input);
  const output = finite(price.output);
  // 没单独给 cacheRead 价格时按 input 计，cacheWrite 按 input 计——保守近似，不臆造折扣。
  // reasoning 通常是 completion tokens 的子集，不重复计价。
  const cacheRead = Number.isFinite(price.cacheRead) ? price.cacheRead : input;
  const cacheWrite = Number.isFinite(price.cacheWrite) ? price.cacheWrite : input;
  return (
    (input * finite(entry.usage.promptTokens) +
      cacheRead * finite(entry.usage.cacheReadTokens) +
      cacheWrite * finite(entry.usage.cacheWriteTokens) +
      output * finite(entry.usage.completionTokens)) /
    1_000_000
  );
}

function finalizeAgg(agg) {
  const sorted = [...agg.durations].sort((a, b) => a - b);
  const pick = (ratio) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))] : 0);
  const avg = agg.requests ? agg.durationMs / agg.requests : 0;
  const seconds = agg.durationMs / 1000;
  const promptBasis = agg.promptTokens + agg.cacheReadTokens;
  return {
    requests: agg.requests,
    succeeded: agg.succeeded,
    failed: agg.failed,
    clientErrors: agg.clientErrors,
    serverErrors: agg.serverErrors,
    transportErrors: agg.transportErrors,
    failureRate: agg.requests ? agg.failed / agg.requests : 0,
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    totalTokens: agg.totalTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    reasoningTokens: agg.reasoningTokens,
    avgPromptTokens: agg.requests ? agg.promptTokens / agg.requests : 0,
    avgCompletionTokens: agg.requests ? agg.completionTokens / agg.requests : 0,
    outputRatio: agg.totalTokens ? agg.completionTokens / agg.totalTokens : 0,
    cacheReadRate: promptBasis ? agg.cacheReadTokens / promptBasis : 0,
    avgDurationMs: avg,
    p50DurationMs: pick(0.5),
    p95DurationMs: pick(0.95),
    maxDurationMs: sorted.length ? sorted[sorted.length - 1] : 0,
    completionTokensPerSecond: seconds > 0 ? agg.completionTokens / seconds : 0,
    cost: agg.cost,
  };
}

/**
 * 按模型 / 来源 / 总量三档汇总。
 * 模型名是展示名（如 copilot:gpt-5），来源取自 provider 名。
 */
export function summarize(entries, { prices = {}, currency = 'USD' } = {}) {
  const total = emptyAgg();
  const byModel = new Map();
  const bySource = new Map();
  const bySession = new Map();
  for (const raw of entries) {
    const entry = normalizeEntry(raw, Date.now());
    if (!entry) continue;
    mergeInto(total, entry, prices, currency);
    if (!byModel.has(entry.model)) byModel.set(entry.model, emptyAgg());
    mergeInto(byModel.get(entry.model), entry, prices, currency);
    if (!bySource.has(entry.source)) bySource.set(entry.source, emptyAgg());
    mergeInto(bySource.get(entry.source), entry, prices, currency);
    if (entry.sessionId) {
      if (!bySession.has(entry.sessionId)) {
        bySession.set(entry.sessionId, { agg: emptyAgg(), key: entry.sessionKey });
      }
      const row = bySession.get(entry.sessionId);
      if (!row.key && entry.sessionKey) row.key = entry.sessionKey;
      mergeInto(row.agg, entry, prices, currency);
    }
  }
  const asRows = (map) =>
    [...map.entries()]
      .map(([name, agg]) => ({ name, ...finalizeAgg(agg) }))
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  return {
    currency,
    hasPrices: Boolean(prices && Object.keys(prices).length),
    entries: entries.length,
    total: finalizeAgg(total),
    byModel: asRows(byModel),
    bySource: asRows(bySource),
    bySession: [...bySession.entries()]
      .map(([name, row]) => ({ name, key: row.key, ...finalizeAgg(row.agg) }))
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
  };
}

/**
 * 逐请求一行日志。文本刻意用 ASCII key=value，方便 grep；
 * 标签 [usage] 也不翻译（与 [req] / [res] 同一约定）。
 */
export function formatUsageLog(entry) {
  const e = normalizeEntry(entry, Date.now());
  if (!e) return '';
  const u = e.usage;
  return (
    `[usage] model=${e.model} source=${e.source} status=${e.status} ` +
    `session=${e.sessionId || '-'} ` +
    `in=${u.promptTokens} out=${u.completionTokens} total=${u.totalTokens} ` +
    `cacheRead=${u.cacheReadTokens} ${e.durationMs}ms ok=${e.ok}`
  );
}

/** CJK 字符按两列算，终端表格才不会错位。 */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uff01-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  }
  return width;
}

function pad(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function table(headers, rows) {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i]))),
  );
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const integer = (value) => String(Math.round(finite(value)));
const percent = (value) => `${(finite(value) * 100).toFixed(1)}%`;
const decimal = (value) => finite(value).toFixed(1);
const money = (value, currency) => `${currency} ${finite(value).toFixed(4)}`;

/** 终端报表。语言由调用方通过 --lang 设定，这里只负责排版。 */
export function formatUsageReport(summary, { file = null, limit = 20 } = {}) {
  const total = summary.total || finalizeAgg(emptyAgg());
  const lines = [];
  lines.push(t('usage.report.heading', { count: summary.entries ?? total.requests, file: file || '-' }));

  lines.push('', t('usage.report.totals'));
  lines.push(
    table(
      [t('usage.col.metric'), t('usage.col.value')],
      [
        [t('usage.metric.requests'), `${integer(total.requests)} (${percent(1 - total.failureRate)} ${t('usage.metric.success')})`],
        [t('usage.metric.failed'), `${integer(total.failed)} (4xx ${integer(total.clientErrors)} / 5xx ${integer(total.serverErrors)} / ${t('usage.metric.transport')} ${integer(total.transportErrors)})`],
        [t('usage.metric.tokens'), `${integer(total.totalTokens)} (${t('usage.metric.in')} ${integer(total.promptTokens)} / ${t('usage.metric.out')} ${integer(total.completionTokens)})`],
        [t('usage.metric.cacheRead'), `${integer(total.cacheReadTokens)} (${percent(total.cacheReadRate)})`],
        [t('usage.metric.cacheWrite'), integer(total.cacheWriteTokens)],
        [t('usage.metric.reasoning'), integer(total.reasoningTokens)],
        [t('usage.metric.latency'), `${t('usage.metric.avg')} ${integer(total.avgDurationMs)}ms / p95 ${integer(total.p95DurationMs)}ms / ${t('usage.metric.max')} ${integer(total.maxDurationMs)}ms`],
        [t('usage.metric.throughput'), `${decimal(total.completionTokensPerSecond)} tok/s`],
        [t('usage.metric.avgTokens'), `${t('usage.metric.in')} ${decimal(total.avgPromptTokens)} / ${t('usage.metric.out')} ${decimal(total.avgCompletionTokens)} (${t('usage.metric.outRatio')} ${percent(total.outputRatio)})`],
        [t('usage.metric.cost'), summary.hasPrices ? money(total.cost, summary.currency) : t('usage.metric.noPrice')],
      ],
    ),
  );

  if (summary.bySource?.length) {
    lines.push('', t('usage.report.bySource'));
    lines.push(
      table(
        [t('usage.col.source'), t('usage.col.requests'), t('usage.col.tokens'), t('usage.col.fail'), t('usage.col.cost')],
        summary.bySource.slice(0, limit).map((row) => [
          row.name,
          integer(row.requests),
          integer(row.totalTokens),
          percent(row.failureRate),
          summary.hasPrices ? money(row.cost, summary.currency) : '-',
        ]),
      ),
    );
  }

  if (summary.byModel?.length) {
    lines.push('', t('usage.report.byModel'));
    lines.push(
      table(
        [t('usage.col.model'), t('usage.col.requests'), t('usage.col.tokens'), t('usage.col.avgMs'), t('usage.col.tokPerSec')],
        summary.byModel.slice(0, limit).map((row) => [
          row.name,
          integer(row.requests),
          integer(row.totalTokens),
          integer(row.avgDurationMs),
          decimal(row.completionTokensPerSecond),
        ]),
      ),
    );
    const hidden = summary.byModel.length - Math.min(limit, summary.byModel.length);
    if (hidden > 0) lines.push(t('usage.report.more', { count: hidden }));
  }

  if (summary.bySession?.length) {
    lines.push('', t('usage.report.bySession'));
    lines.push(
      table(
        [t('usage.col.session'), t('usage.col.requests'), t('usage.col.tokens'), t('usage.col.avgMs'), t('usage.col.cost')],
        summary.bySession.slice(0, limit).map((row) => [
          row.name,
          integer(row.requests),
          integer(row.totalTokens),
          integer(row.avgDurationMs),
          summary.hasPrices ? money(row.cost, summary.currency) : '-',
        ]),
      ),
    );
    const hidden = summary.bySession.length - Math.min(limit, summary.bySession.length);
    if (hidden > 0) lines.push(t('usage.report.more', { count: hidden }));
  }

  if (!summary.hasPrices) lines.push('', t('usage.report.priceHint'));
  return `${lines.join('\n')}\n`;
}

/**
 * 用量仓库：内存聚合 + append-only JSONL 落盘。
 * 读、写、轮转全程吞错——统计永远不能把代理搞挂。
 */
export class UsageStore {
  constructor({
    file = null,
    env = process.env,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    prices = {},
    currency = 'USD',
    clock = () => Date.now(),
  } = {}) {
    this.filePath = usageFilePath(env, file);
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : DEFAULT_MAX_ENTRIES;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    this.prices = prices && typeof prices === 'object' ? prices : {};
    this.currency = typeof currency === 'string' && currency ? currency : 'USD';
    this.clock = typeof clock === 'function' ? clock : () => Date.now();
    this.entries = [];
    this.dropped = 0;
    this.load();
  }

  /** 重启后重载；坏行跳过，只有完整 JSON 对象才算数。 */
  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const content = fs.readFileSync(this.filePath, 'utf8');
      const rows = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
        .map((row) => normalizeEntry(row, this.clock()))
        .filter(Boolean);
      this.entries = rows.slice(-this.maxEntries);
      this.dropped = Math.max(0, rows.length - this.entries.length);
    } catch {
      this.entries = [];
    }
  }

  record(raw) {
    const entry = normalizeEntry({ ...raw, ts: raw?.ts || new Date(this.clock()).toISOString() }, this.clock());
    if (!entry) return null;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
      this.dropped += 1;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      this.#rotateIfNeeded();
    } catch {
      /* 磁盘满 / 只读：内存统计继续工作 */
    }
    return entry;
  }

  #rotateIfNeeded() {
    let size;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;
    try {
      // 只留一份 .1：统计是聚合数据，不需要像日志那样留多份历史
      const backup = `${this.filePath}.1`;
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(this.filePath, backup);
    } catch {
      /* 轮转失败就继续追加，不能影响请求 */
    }
  }

  summary() {
    return summarize(this.entries, { prices: this.prices, currency: this.currency });
  }

  report(options = {}) {
    return formatUsageReport(this.summary(), { file: this.filePath, ...options });
  }
}

/**
 * CLI 用：不启服务，只读一份 JSONL 并打印汇总。
 * 返回 { ok, text, file, message }，由调用方决定退出码。
 */
export function readUsageReport({ file = null, env = process.env, prices = {}, currency = 'USD', limit = 20, lang = null } = {}) {
  const previous = getLang();
  if (lang) setLang(lang);
  try {
    const store = new UsageStore({ file, env, prices, currency });
    return { ok: true, text: store.report({ file: store.filePath, limit }), file: store.filePath };
  } catch (error) {
    return { ok: false, text: '', file: usageFilePath(env, file), message: error.message };
  } finally {
    setLang(previous);
  }
}
