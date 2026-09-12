import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LEVELS, Logger, ROTATE_MODES, dateStamp, logDetail } from '../src/logger.js';
import { DEFAULT_LANG, setLang } from '../src/messages.js';

function tempFile(name = 'app.log') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-'));
  return path.join(dir, name);
}

/** 造一个可控时钟：返回值可被用例改写。 */
function fakeClock(iso) {
  let current = new Date(iso);
  const clock = () => current;
  clock.set = (next) => {
    current = new Date(next);
  };
  return clock;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 把文件的 mtime 拨到 N 天前。 */
function ageBy(file, days) {
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(file, when, when);
}

test('日志级别过滤：低于阈值的调用不落盘', () => {
  const file = tempFile();
  const logger = new Logger({ level: 'warn', file, console: false });

  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('[DEBUG]'), 'debug 应当被过滤');
  assert.ok(!text.includes('[INFO]'), 'info 应当被过滤');
  assert.ok(text.includes('[WARN] w'));
  assert.ok(text.includes('[ERROR] e'));
});

test('silent 级别下不写任何内容', () => {
  const file = tempFile();
  const logger = new Logger({ level: 'silent', file, console: false });
  logger.error('should not appear');
  logger.info('neither');

  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.equal(text, '');
});

test('写文件时自动创建多级目录，并追加到已有内容之后', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-'));
  const file = path.join(dir, 'nested', 'deep', 'app.log');

  new Logger({ level: 'info', file, console: false }).info('first');
  new Logger({ level: 'info', file, console: false }).info('second');

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('first'));
  assert.ok(text.includes('second'), '两次运行应当追加而不是覆盖');
});

test('未配置日志文件时只走控制台，不创建文件', () => {
  const logger = new Logger({ level: 'info', console: false });
  assert.equal(logger.filePath, null);
  assert.doesNotThrow(() => logger.info('nowhere'));
});

test('超过 maxBytes 时轮转，备份份数不超过设定值', () => {
  const file = tempFile('rotate.log');
  const logger = new Logger({ level: 'info', file, console: false, maxBytes: 200, backups: 2 });

  for (let i = 0; i < 60; i += 1) logger.info(`line-${i}-${'x'.repeat(20)}`);

  assert.ok(fs.existsSync(file), '主日志文件应当存在');
  assert.ok(fs.existsSync(`${file}.1`), '应当产生第一份备份');
  assert.ok(!fs.existsSync(`${file}.3`), '备份份数不应超过 backups');
});

test('轮转后主日志仍可继续写入且内容完整', () => {
  const file = tempFile('rotate2.log');
  const logger = new Logger({ level: 'info', file, console: false, maxBytes: 150, backups: 1 });

  logger.info(`BEFORE-${'y'.repeat(200)}`);
  logger.info('AFTER-MARKER');

  assert.ok(fs.readFileSync(file, 'utf8').includes('AFTER-MARKER'), '轮转后新内容应写进主文件');
  assert.ok(fs.readFileSync(`${file}.1`, 'utf8').includes('BEFORE'), '旧内容应被移入备份');
});

test('child 生成带固定前缀的日志器', () => {
  const file = tempFile('child.log');
  const logger = new Logger({ level: 'info', file, console: false });
  logger.child('[sub]').info('message');

  assert.ok(fs.readFileSync(file, 'utf8').includes('[sub] message'));
});

test('对象与 Error 参数会被安全序列化', () => {
  const file = tempFile('types.log');
  const logger = new Logger({ level: 'info', file, console: false });

  logger.info({ a: 1, b: 'x' });
  logger.warn(new Error('boom'));

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('{"a":1,"b":"x"}'));
  assert.ok(text.includes('boom'));
});

test('close 可重复调用且不抛错', () => {
  const logger = new Logger({ level: 'info', file: tempFile('close.log'), console: false });
  logger.info('done');
  logger.close();
  assert.doesNotThrow(() => logger.close());
});

test('LEVELS 常量覆盖文档承诺的五个级别且顺序正确', () => {
  assert.deepEqual(Object.keys(LEVELS), ['silent', 'error', 'warn', 'info', 'debug']);
  assert.ok(LEVELS.silent < LEVELS.error);
  assert.ok(LEVELS.error < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.debug);
});

test('未知级别名退回 info，不会静默丢日志', () => {
  const file = tempFile('unknown-level.log');
  const logger = new Logger({ level: 'verbose', file, console: false });
  logger.info('still logged');
  assert.ok(fs.readFileSync(file, 'utf8').includes('still logged'));
});

// ---------------------------------------------------------------- 按日期轮转

test('daily 模式把日期写进文件名，跨天自动换新文件', () => {
  const file = tempFile('daily.log');
  const dir = path.dirname(file);
  const clock = fakeClock('2026-03-04T23:00:00');

  const logger = new Logger({ level: 'info', file, rotate: 'daily', console: false, clock });
  logger.info('first-day');
  const first = path.join(dir, 'daily-2026-03-04.log');
  assert.ok(fs.existsSync(first), `应当写到当天日期的文件 ${first}`);
  assert.equal(logger.filePath, first, 'filePath 应当指向今天这个文件，而不是基准名');

  clock.set('2026-03-05T00:10:00');
  logger.info('second-day');
  const second = path.join(dir, 'daily-2026-03-05.log');
  assert.ok(fs.existsSync(second), '跨天后应当另起一个文件');
  assert.ok(fs.readFileSync(first, 'utf8').includes('first-day'));
  assert.ok(fs.readFileSync(second, 'utf8').includes('second-day'));
  assert.ok(!fs.readFileSync(second, 'utf8').includes('first-day'), '两个文件内容不应串');
});

test('daily 模式下 maxBytes 依然生效，备份带当天日期', () => {
  const file = tempFile('daily-size.log');
  const dir = path.dirname(file);
  const clock = fakeClock('2026-03-04T09:00:00');

  const logger = new Logger({
    level: 'info',
    file,
    rotate: 'daily',
    maxBytes: 120,
    backups: 1,
    console: false,
    clock,
  });
  for (let i = 0; i < 10; i += 1) logger.info(`line-${i}-${'x'.repeat(20)}`);

  assert.ok(fs.existsSync(path.join(dir, 'daily-size-2026-03-04.log.1')), '应当产生带日期的备份');
});

test('rotate=off 时不轮转也不截断，始终写同一个文件', () => {
  const file = tempFile('off.log');
  const logger = new Logger({
    level: 'info',
    file,
    rotate: 'off',
    maxBytes: 50,
    console: false,
  });
  for (let i = 0; i < 20; i += 1) logger.info(`line-${i}-${'y'.repeat(20)}`);

  assert.ok(!fs.existsSync(`${file}.1`), 'off 模式不应产生备份');
  assert.ok(fs.readFileSync(file, 'utf8').includes('line-19'), '同一個文件一直追加');
});

test('backups=0 时旧内容直接丢弃，不留备份文件', () => {
  const file = tempFile('keep0.log');
  const logger = new Logger({ level: 'info', file, maxBytes: 80, backups: 0, console: false });

  logger.info(`OLD-${'z'.repeat(200)}`);
  logger.info('NEW-MARKER');

  assert.ok(!fs.existsSync(`${file}.1`), '不应当留下备份');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('NEW-MARKER'));
  assert.ok(!text.includes('OLD-'), '旧内容应当被丢弃而不是无限累积');
});

// ---------------------------------------------------------------- 归档清理

test('启动时删除超过 keepDays 天的历史日志，只认自己的命名规则', () => {
  const file = tempFile('app.log');
  const dir = path.dirname(file);

  const owned = {
    oldBackup: path.join(dir, 'app.log.1'),
    freshBackup: path.join(dir, 'app.log.2'),
    oldDated: path.join(dir, 'app-2020-01-01.log'),
    freshDated: path.join(dir, `app-${dateStamp()}.log`),
  };
  for (const p of Object.values(owned)) fs.writeFileSync(p, 'x\n', 'utf8');
  ageBy(owned.oldBackup, 60);
  ageBy(owned.freshBackup, 1);
  ageBy(owned.oldDated, 400);
  ageBy(owned.freshDated, 0);

  const strangers = {
    otherLog: path.join(dir, 'other.log'),
    txt: path.join(dir, 'notes.txt'),
    prefixed: path.join(dir, 'my-app.log'),
  };
  for (const p of Object.values(strangers)) fs.writeFileSync(p, 'y\n', 'utf8');
  for (const p of Object.values(strangers)) ageBy(p, 400);

  new Logger({ level: 'info', file, console: false, keepDays: 30 });

  assert.ok(!fs.existsSync(owned.oldBackup), '超过 30 天的 app.log.1 应当被删除');
  assert.ok(!fs.existsSync(owned.oldDated), '超过 30 天的 app-2020-01-01.log 应当被删除');
  assert.ok(fs.existsSync(owned.freshBackup), '1 天前的备份应当保留');
  assert.ok(fs.existsSync(owned.freshDated), '今天的日志应当保留');
  for (const [label, p] of Object.entries(strangers)) {
    assert.ok(fs.existsSync(p), `不应当误删同目录里无关的文件（${label}）`);
  }
});

test('正在写入的文件即使很旧也不会被归档清掉', () => {
  const file = tempFile('active.log');
  fs.writeFileSync(file, 'previous run\n', 'utf8');
  ageBy(file, 300);

  const logger = new Logger({ level: 'info', file, console: false, keepDays: 30 });
  assert.ok(fs.existsSync(file), '主日志文件不应被自己删掉');

  logger.info('after-restart');
  assert.ok(fs.readFileSync(file, 'utf8').includes('after-restart'));
});

test('keepDays=0 表示永久保留，不做任何清理', () => {
  const file = tempFile('forever.log');
  const dir = path.dirname(file);
  const old = path.join(dir, 'forever.log.1');
  fs.writeFileSync(old, 'x\n', 'utf8');
  ageBy(old, 900);

  new Logger({ level: 'info', file, console: false, keepDays: 0 });
  assert.ok(fs.existsSync(old), 'keepDays=0 时不应删除任何文件');
});

test('长期运行时也会按间隔兜底清理（不必等下次重启）', () => {
  const file = tempFile('sweep.log');
  const dir = path.dirname(file);
  const clock = fakeClock('2026-03-04T09:00:00');
  const logger = new Logger({ level: 'info', file, rotate: 'daily', console: false, clock });
  logger.info('day-one');

  // 造一个 40 天前（相对假时钟）的历史文件，再把时钟往前推一天写一行
  const stale = path.join(dir, 'sweep-2026-01-20.log');
  fs.writeFileSync(stale, 'old\n', 'utf8');
  const when = new Date('2026-01-20T09:00:00');
  fs.utimesSync(stale, when, when);

  clock.set('2026-03-05T09:00:00');
  logger.info('day-two');

  assert.ok(!fs.existsSync(stale), '时钟越过扫描间隔后应当清掉超期文件');
});

test('rotation 与 dateStamp 暴露的契约稳定', () => {
  const file = tempFile('contract.log');
  const logger = new Logger({
    level: 'info',
    file,
    rotate: 'daily',
    maxBytes: 1024,
    backups: 3,
    keepDays: 7,
    console: false,
  });

  assert.deepEqual(logger.rotation, {
    rotate: 'daily',
    maxBytes: 1024,
    backups: 3,
    keepDays: 7,
  });
  assert.equal(logger.basePath, file);
  assert.deepEqual(ROTATE_MODES, ['size', 'daily', 'off']);
  assert.match(dateStamp(new Date('2026-01-02T03:04:05')), /^2026-01-02$/);
});

test('logDetail 概括轮转与归档策略，分隔符跟随语言', () => {
  const log = { rotate: 'size', maxBytes: 1024, backups: 2, keepDays: 30 };

  try {
    setLang('en');
    const en = logDetail(log);
    assert.match(en, /size rotation, max 1024 B, 2 backups, keep 30 days/);

    setLang('zh');
    const zh = logDetail(log);
    assert.match(zh, /按大小轮转/);
    assert.match(zh, /保留 30 天/);
    assert.ok(!zh.includes(', '), `中文说明不该用半角逗号分隔: ${zh}`);
    assert.ok(zh.includes('，'), `中文说明应当用全角逗号: ${zh}`);
  } finally {
    setLang(DEFAULT_LANG);
  }
});

test('logDetail 覆盖关闭轮转与永久保留两种边界', () => {
  try {
    setLang('en');
    assert.match(logDetail({ rotate: 'off', keepDays: 0 }), /no rotation.*keep forever/);
    assert.match(logDetail({ rotate: 'daily', maxBytes: 512, backups: 0, keepDays: 7 }), /daily rotation/);
  } finally {
    setLang(DEFAULT_LANG);
  }
});
