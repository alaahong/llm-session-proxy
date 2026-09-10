import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const COLORS = { error: 31, warn: 33, info: 36, debug: 90 };

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
 * 极简日志器：同时写控制台（TTY 带色）与可选文件（按大小轮转）。
 * 不依赖任何第三方库。
 */
export class Logger {
  constructor(options = {}) {
    const {
      level = 'info',
      file = null,
      maxBytes = 5 * 1024 * 1024,
      backups = 2,
      console: toConsole = true,
    } = options;

    this.level = LEVELS[level] ?? LEVELS.info;
    this.toConsole = toConsole;
    this.maxBytes = maxBytes;
    this.backups = Math.max(0, backups);
    this.file = file ? path.resolve(file) : null;
    this.stream = null;
    this.written = 0;

    if (this.file) this.#openStream();
  }

  get filePath() {
    return this.file;
  }

  #openStream() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      /* 目录创建失败时退化为仅控制台输出 */
    }
    try {
      this.written = fs.statSync(this.file).size;
    } catch {
      this.written = 0;
    }
    try {
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  #rotate() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
    try {
      for (let i = this.backups - 1; i >= 1; i -= 1) {
        const src = `${this.file}.${i}`;
        const dst = `${this.file}.${i + 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* 轮转失败不影响主流程 */
    }
    this.written = 0;
    this.#openStream();
  }

  #writeFile(line) {
    if (!this.stream) return;
    const buf = Buffer.from(`${line}\n`, 'utf8');
    if (this.maxBytes > 0 && this.written + buf.length > this.maxBytes) {
      this.#rotate();
      if (!this.stream) return;
    }
    this.stream.write(buf);
    this.written += buf.length;
  }

  #emit(level, args) {
    if (LEVELS[level] > this.level) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const text = args.map(stringify).join(' ');
    const line = `${ts} [${level.toUpperCase()}] ${text}`;
    if (this.toConsole) {
      const color = COLORS[level] || 0;
      const out = process.stderr.isTTY ? `\u001b[${color}m${line}\u001b[0m` : line;
      process.stderr.write(`${out}\n`);
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

  close() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
  }
}

export { LEVELS };
