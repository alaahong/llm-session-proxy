import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Logger } from '../src/logger.js';

/**
 * 日志器的容错分支覆盖。
 *
 * logger.test.mjs 覆盖的是「正常情况下怎么落盘、怎么轮转」，这里补的是**日志器自己
 * 出问题时的表现**：写盘失败、目录没了、轮转时改名失败、stderr 管道被关掉。
 *
 * 判据统一：**日志器绝不能因为写日志而把代理搞挂**——写盘失败、stderr 不可写，
 * 都只能降级不能抛；同时不能悄悄丢行（轮转与归档的判定要正确）。
 */

/** 造一个临时日志文件路径（目录会自动创建）。 */
function tempFile(name = 'app.log') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-branches-'));
  return path.join(dir, name);
}

/** 可控时钟：返回值可被用例改写。 */
function fakeClock(iso) {
  let current = new Date(iso);
  const clock = () => current;
  clock.set = (next) => {
    current = new Date(next);
  };
  return clock;
}

// ---------------------------------------------------------------- 参数序列化

test('stringify：循环引用的对象降级成字符串，不抛异常', () => {
  const file = tempFile('circular.log');
  const logger = new Logger({ level: 'info', file, console: false });

  const circular = { name: 'loop' };
  circular.self = circular;

  assert.doesNotThrow(() => logger.info(circular));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('[INFO]'), '日志行照样写出来');
  assert.ok(text.includes('loop'), '还能看出写的是哪个对象');
  assert.ok(text.includes('[Circular]'), '循环的那一段要标出来，而不是整条丢成 [object Object]');
});

test('stringify：Error 走 stack，没有 stack 时退回 message', () => {
  const file = tempFile('error.log');
  const logger = new Logger({ level: 'info', file, console: false });

  const error = new Error('boom');
  error.stack = '';
  logger.warn(error);

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('boom'), '没有 stack 也要能看出错误内容');
});

test('stringify：连兜底的序列化都失败时退化成字符串，不抛异常', () => {
  const file = tempFile('tojson.log');
  const logger = new Logger({ level: 'info', file, console: false });

  const nasty = {
    toJSON() {
      throw new Error('toJSON 炸了');
    },
  };

  assert.doesNotThrow(() => logger.info(nasty));
  assert.ok(fs.readFileSync(file, 'utf8').includes('[INFO]'), '日志行照样写出来');
});

// ---------------------------------------------------------------- 归档扫描

test('#sweep：目录读不出来时安静跳过，不影响后续写日志', () => {
  const file = tempFile('sweep.log');
  const dir = path.dirname(file);
  const clock = fakeClock('2026-03-04T09:00:00');
  const logger = new Logger({ level: 'info', file, rotate: 'daily', console: false, clock, keepDays: 7 });

  // 把日志目录换成一个同名文件：readdirSync 会抛 ENOTDIR
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a directory', 'utf8');

  clock.set('2026-03-05T09:00:00'); // 越过扫描间隔，逼它真的去扫一次
  assert.doesNotThrow(() => logger.info('扫不动也要活着'));
});

test('#sweep：单个文件读不出来不影响其余文件', () => {
  const file = tempFile('partial.log');
  const dir = path.dirname(file);
  const broken = path.join(dir, 'partial.log.1');
  const fine = path.join(dir, 'partial.log.2');
  fs.writeFileSync(broken, 'x\n', 'utf8');
  fs.writeFileSync(fine, 'x\n', 'utf8');
  const when = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  fs.utimesSync(broken, when, when);
  fs.utimesSync(fine, when, when);

  // 让这一个文件的 stat 失败（权限/文件刚好被别人删掉都可能），
  // 扫目录时不能因为它就把整轮清理都放弃。
  const original = fs.statSync;
  fs.statSync = (target, ...rest) => {
    if (String(target) === broken) {
      throw Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
    }
    return original(target, ...rest);
  };
  try {
    const logger = new Logger({ level: 'info', file, console: false, keepDays: 30 });
    assert.doesNotThrow(() => logger.info('还在写'));
  } finally {
    fs.statSync = original;
  }

  assert.ok(fs.existsSync(broken), '读不出来的那个文件留着，不影响别的');
  assert.ok(!fs.existsSync(fine), '其余超期归档照常清掉');
});

// ---------------------------------------------------------------- 轮转

test('#rotate：改名失败时不影响继续写日志', () => {
  const file = tempFile('rotate-fail.log');
  const dir = path.dirname(file);

  // 先占住备份名（目录），renameSync 会失败
  fs.mkdirSync(path.join(dir, 'rotate-fail.log.1'));

  const logger = new Logger({ level: 'info', file, console: false, maxBytes: 100, backups: 1 });
  assert.doesNotThrow(() => logger.info(`长一点的内容-${'x'.repeat(200)}`));
  assert.doesNotThrow(() => logger.info('轮转失败也要继续写'));
});

// ---------------------------------------------------------------- 写盘

test('写盘失败时静默降级，日志器继续活着', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-branches-'));
  const file = path.join(dir, 'app.log');
  // 日志文件的位置先占成一个目录：appendFileSync 会抛 EISDIR
  fs.mkdirSync(file);

  const logger = new Logger({ level: 'info', file, console: false });
  assert.doesNotThrow(() => logger.info('写不进去'));
  assert.doesNotThrow(() => logger.error('还是写不进去'));
});

// ---------------------------------------------------------------- 控制台输出

test('控制台输出：不是 TTY 时不套颜色码', () => {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const logger = new Logger({ level: 'info', console: true });
    logger.info('plain-line');
  } finally {
    process.stderr.write = original;
  }

  const out = chunks.join('');
  assert.ok(out.includes('plain-line'), '内容要原样输出');
  assert.ok(!out.includes('\u001b['), '非 TTY 不该有颜色码');
});

test('控制台输出：TTY 时按级别上色', () => {
  const originalWrite = process.stderr.write;
  const originalIsTty = process.stderr.isTTY;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  try {
    const logger = new Logger({ level: 'info', console: true });
    logger.error('colored-line');
  } finally {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTty, configurable: true });
  }

  const out = chunks.join('');
  assert.ok(out.includes('\u001b[31m'), 'error 应当是红色');
  assert.ok(out.includes('colored-line'));
  assert.ok(out.includes('\u001b[0m'), '结尾要复位颜色');
});

test('控制台输出：write 抛错时吞掉，文件通道继续', () => {
  const file = tempFile('epipe.log');
  const original = process.stderr.write;
  process.stderr.write = () => {
    const error = new Error('EPIPE: broken pipe, write');
    error.code = 'EPIPE';
    throw error;
  };
  try {
    const logger = new Logger({ level: 'info', file, console: true });
    assert.doesNotThrow(() => logger.info('stderr 写不出去'));
  } finally {
    process.stderr.write = original;
  }

  assert.ok(fs.readFileSync(file, 'utf8').includes('stderr 写不出去'), '文件通道不受影响');
});

test('控制台输出：stderr 管道被关掉时进程不会被带走（EPIPE 是异步 error 事件）', async () => {
  // write 遇到断开的管道**不会同步抛错**，而是异步在 process.stderr 上发一个
  // EPIPE 的 'error' 事件。没有监听器的话它会变成未捕获异常，把代理直接带走。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-epipe-'));
  const script = path.join(dir, 'child.mjs');
  const loggerPath = fileURLToPath(new URL('../src/logger.js', import.meta.url));
  fs.writeFileSync(
    script,
    [
      `import { Logger } from ${JSON.stringify(pathToFileURL(loggerPath).href)};`,
      'const logger = new Logger({ level: "info" });',
      'logger.info("first");',
      'setTimeout(() => { logger.info("second"); setTimeout(() => process.exit(0), 200); }, 80);',
    ].join('\n'),
    'utf8',
  );

  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  // 父进程读端一关， child's stderr 写就断了
  child.stderr.on('data', () => child.stderr.destroy());

  const code = await exited;
  assert.equal(code, 0, 'stderr 断了也不该把进程带走');
});

// ---------------------------------------------------------------- 时钟与派生日志器

test('clock 不是函数时退回默认时钟，日志照常写', () => {
  const file = tempFile('clock.log');
  const logger = new Logger({ level: 'info', file, console: false, clock: 'not-a-function' });

  assert.doesNotThrow(() => logger.info('默认时钟'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('默认时钟'));
});

test('child 派生出的四个级别都能用', () => {
  const file = tempFile('child-all.log');
  const logger = new Logger({ level: 'debug', file, console: false });
  const child = logger.child('[sub]');

  child.error('e');
  child.warn('w');
  child.info('i');
  child.debug('d');

  const text = fs.readFileSync(file, 'utf8');
  for (const level of ['ERROR', 'WARN', 'INFO', 'DEBUG']) {
    assert.ok(text.includes(`[${level}]`), `应当写出 ${level}`);
  }
  assert.ok(text.includes('[sub]'), '前缀要带上');
});

// ---------------------------------------------------------------- 轮转判定

test('轮转判定：刚好到上限不轮转，超出一个字节才轮转', () => {
  const file = tempFile('boundary.log');
  const logger = new Logger({ level: 'info', file, console: false, maxBytes: 4096, backups: 1 });

  logger.info('a'.repeat(10));
  assert.ok(!fs.existsSync(`${file}.1`), '没到上限不该轮转');

  // 一口气写到超过 maxBytes
  logger.info('b'.repeat(5000));
  assert.ok(fs.existsSync(`${file}.1`), '超过上限就该轮转');
  assert.ok(fs.readFileSync(file, 'utf8').includes('b'.repeat(5000)), '新内容写进主文件');
});

test('归档判定：正在写的文件永远不删，同目录的无关文件也不动', () => {
  const file = tempFile('keep.log');
  const dir = path.dirname(file);
  const stranger = path.join(dir, 'unrelated.log');
  fs.writeFileSync(stranger, 'y\n', 'utf8');
  const when = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stranger, when, when);

  const logger = new Logger({ level: 'info', file, console: false, keepDays: 30 });
  logger.info('x');

  assert.ok(fs.existsSync(file), '主日志文件不能被自己删掉');
  assert.ok(fs.existsSync(stranger), '别人的文件不能被删');
});

test('不合法的轮转参数退回安全值，不影响日志本身', () => {
  const file = tempFile('fallback.log');
  const logger = new Logger({
    level: 'info',
    file,
    console: false,
    rotate: 'weekly',
    maxBytes: -1,
    backups: 'not-a-number',
  });

  assert.equal(logger.rotate, 'size', '未知轮转模式退回按大小');
  assert.equal(logger.maxBytes, 0, '负的上限等于不限制');
  assert.equal(logger.backups, 0, '备份份数退回 0');

  assert.doesNotThrow(() => logger.info('照常写'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('照常写'));
});

test('日志目录建不出来时退化成只写控制台，不抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-branches-'));
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory', 'utf8');

  const logger = new Logger({ level: 'info', file: path.join(blocked, 'app.log'), console: false });
  assert.doesNotThrow(() => logger.info('写不下去也不能崩'));
});

test('日志文件没有扩展名时归档匹配照样成立', () => {
  const file = tempFile('noext');
  const dir = path.dirname(file);
  const old = path.join(dir, 'noext.1');
  fs.writeFileSync(old, 'x\n', 'utf8');
  const when = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, when, when);

  const logger = new Logger({ level: 'info', file, console: false, keepDays: 30 });
  logger.info('x');

  assert.ok(!fs.existsSync(old), '没有扩展名也要能认出归档文件并清掉');
});
