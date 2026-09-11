import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const COLORS = { error: 31, warn: 33, info: 36, debug: 90 };

/** 轮转策略：按大小 / 按日期 / 不轮转。 */
export const ROTATE_MODES = ['size', 'daily', 'off'];

/**
 * 归档扫描的最小间隔。
 * 扫目录很便宜，但没必要每写一行都扫；进程活得久时才需要定期兜底清理。
 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地日期戳（YYYY-MM-DD）。用本地时间，才符合"今天的日志"这个直觉。 */
export function dateStamp(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 极简日志器：同时写控制台（TTY 带色）与文件（按大小或日期轮转 + 超期归档）。
 * 不依赖任何第三方库。
 *
 * 文件写入刻意采用同步 API：日志量小（每请求两三行），换来的是
 * "进程退出/轮转时不会丢最后几行"这一确定性——排错时最需要的正是尾部日志。
 *
 * 文件命名约定（归档清理只认这一套，不会误删同目录里的其他文件）：
 *   - 按大小轮转：`app.log`、`app.log.1`、`app.log.2` …
 *   - 按日期轮转：`app-YYYY-MM-DD.log`（跨天自动换到新文件，单文件超 maxBytes 仍有 `.N` 备份）
 *   - 超过 keepDays 天的上述文件会被删除；`keepDays: 0` 表示永久保留。
 *   - `rotate: 'off'` 时既不换文件也不截断，完全交给外部手段处理。
 */
export class Logger {
  constructor(options = {}) {
    const {
      level = 'info',
      file = null,
      rotate = 'size',
      maxBytes = 5 * 1024 * 1024,
      backups = 2,
      keepDays = 30,
      console: toConsole = true,
      clock = () => new Date(),
    } = options;

    this.level = LEVELS[level] ?? LEVELS.info;
    this.toConsole = toConsole;
    this.clock = typeof clock === 'function' ? clock : () => new Date();

    this.rotate = ROTATE_MODES.includes(rotate) ? rotate : 'size';
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    this.backups = Number.isFinite(backups) ? Math.max(0, Math.floor(backups)) : 0;
    // 0 表示永久保留（不清理）
    this.keepDays = Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 0;

    this.file = file ? path.resolve(String(file)) : null;
    const parsed = this.file ? path.parse(this.file) : null;
    this.dir = parsed ? parsed.dir : null;
    this.stem = parsed ? parsed.name : null;
    this.ext = parsed ? parsed.ext : null;

    this.written = 0;
    this.activeFile = null;
    this.lastSweep = 0;

    if (this.file) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        /* 目录创建失败时退化为仅控制台输出 */
      }
      this.activeFile = this.#activePath();
      try {
        this.written = fs.statSync(this.activeFile).size;
      } catch {
        this.written = 0;
      }
      // 启动时先清一次历史日志，避免进程长期不重启导致归档一直不生效
      this.#sweep(true);
    }
  }

  /** 当前实际写入的文件路径；未启用文件输出时为 null。 */
  get filePath() {
    return this.file ? this.activeFile || this.file : null;
  }

  /** 用户配置的基准路径（按日期轮转时与 filePath 不同）。 */
  get basePath() {
    return this.file;
  }

  /** 轮转与归档参数快照，供启动横幅等展示用。 */
  get rotation() {
    return {
      rotate: this.rotate,
      maxBytes: this.maxBytes,
      backups: this.backups,
      keepDays: this.keepDays,
    };
  }

  /** 按日期轮转时，今天的文件名；其余模式就是配置的文件名。 */
  #activePath() {
    if (!this.file || this.rotate !== 'daily') return this.file;
    return path.join(this.dir, `${this.stem}-${dateStamp(this.clock())}${this.ext}`);
  }

  /**
   * 只匹配本工具自己产生的文件名，用于归档清理。
   * `app.log` / `app-2026-09-11.log` / `app.log.1` / `app-2026-09-11.log.1`
   */
  #filePattern() {
    if (!this.stem) return null;
    const stem = escapeRegExp(this.stem);
    const ext = escapeRegExp(this.ext || '');
    return new RegExp(`^${stem}(?:-\\d{4}-\\d{2}-\\d{2})?${ext}(?:\\.\\d+)?$`, 'i');
  }

  /** 删掉超过 keepDays 天的历史日志；只碰自己命名规则内的文件。 */
  #sweep(force = false) {
    if (!this.dir || !this.stem || this.keepDays <= 0) return;

    const now = this.clock().getTime();
    if (!force && now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;

    const cutoff = now - this.keepDays * DAY_MS;
    const pattern = this.#filePattern();
    if (!pattern) return;

    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const full = path.join(this.dir, entry.name);
      // 正在写的文件永远不删（两种模式下都保护）
      if (full === this.activeFile || full === this.file) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        /* 单个文件删不掉不影响其余文件 */
      }
    }
  }

  #rotate(base) {
    try {
      if (this.backups < 1) {
        // 不留备份：直接丢弃旧内容，避免无上限增长
        fs.rmSync(base, { force: true });
      } else {
        for (let i = this.backups - 1; i >= 1; i -= 1) {
          const src = `${base}.${i}`;
          if (fs.existsSync(src)) fs.renameSync(src, `${base}.${i + 1}`);
        }
        if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
      }
    } catch {
      /* 轮转失败不影响主流程 */
    }
    this.written = 0;
  }

  #writeFile(line) {
    if (!this.file) return;

    const target = this.#activePath();
    if (target !== this.activeFile) {
      // 跨天换文件（daily）：已有的今日文件（如重启后的续写）要接着算大小
      this.activeFile = target;
      try {
        this.written = fs.statSync(target).size;
      } catch {
        this.written = 0;
      }
    }

    const buf = Buffer.from(`${line}\n`, 'utf8');
    // off 模式完全不轮转；size 与 daily 都尊重 maxBytes（daily 即"每天一个文件，且单文件不超限"）
    if (this.rotate !== 'off' && this.maxBytes > 0 && this.written + buf.length > this.maxBytes) {
      this.#rotate(this.activeFile);
    }
    try {
      fs.appendFileSync(this.activeFile, buf);
      this.written += buf.length;
    } catch {
      /* 写盘失败（磁盘满、权限）时静默降级，不能因为日志挂掉代理 */
    }

    this.#sweep();
  }

  #emit(level, args) {
    if (LEVELS[level] > this.level) return;
    const ts = this.clock().toISOString().replace('T', ' ').slice(0, 19);
    const text = args.map(stringify).join(' ');
    const line = `${ts} [${level.toUpperCase()}] ${text}`;
    if (this.toConsole) {
      const color = COLORS[level] || 0;
      const out = process.stderr.isTTY ? `\u001b[${color}m${line}\u001b[0m` : line;
      try {
        // stderr 被关掉（管道断开）时 write 会抛 EPIPE；
        // 日志器绝不能因为写日志而把代理搞挂
        process.stderr.write(`${out}\n`);
      } catch {
        /* 放弃控制台输出，文件通道继续 */
      }
    }
    this.#writeFile(line);
  }

  error(...args) {
    this.#emit('error', args);
  }

  warn(...args) {
    this.#emit('warn', args);
  }

  info(...args) {
    this.#emit('info', args);
  }

  debug(...args) {
    this.#emit('debug', args);
  }

  child(prefix) {
    return {
      error: (...a) => this.error(prefix, ...a),
      warn: (...a) => this.warn(prefix, ...a),
      info: (...a) => this.info(prefix, ...a),
      debug: (...a) => this.debug(prefix, ...a),
    };
  }

  /** 保留接口：同步写入无需排空缓冲，调用它只是为了语义清晰。 */
  close() {
    /* 无缓冲需要排空 */
  }
}

export { LEVELS };
