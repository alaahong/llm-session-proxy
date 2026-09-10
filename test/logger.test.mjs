import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { LEVELS, Logger } from '../src/logger.js';

function tempFile(name = 'app.log') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-log-'));
  return path.join(dir, name);
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
