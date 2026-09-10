import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArgv } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'llm-session-proxy.js');

const runCli = (args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('parseArgv 解析监听地址与上游 URL', () => {
  const { flags } = parseArgv(['-p', '8080', '--host', '0.0.0.0', '-u', 'http://127.0.0.1:11434/v1']);

  assert.equal(flags.listen.port, 8080);
  assert.equal(flags.listen.host, '0.0.0.0');
  assert.equal(flags.upstream.protocol, 'http');
  assert.equal(flags.upstream.host, '127.0.0.1');
  assert.equal(flags.upstream.port, 11434);
  assert.equal(flags.upstream.basePath, '/v1');
});

test('parseArgv 同时支持 "--flag value" 与 "--flag=value"', () => {
  const spaced = parseArgv(['--port', '9000']);
  const inline = parseArgv(['--port=9000']);
  assert.equal(spaced.flags.listen.port, 9000);
  assert.equal(inline.flags.listen.port, 9000);

  const inlineUpstream = parseArgv(['--upstream=https://example.com/zen/go/v1']);
  assert.equal(inlineUpstream.flags.upstream.host, 'example.com');
  assert.equal(inlineUpstream.flags.upstream.basePath, '/zen/go/v1');
});

test('parseArgv 累积可重复的参数', () => {
  const { flags } = parseArgv([
    '--inject', 'x-a=1',
    '--inject', 'x-b={{session.id}}',
    '--model-map', 'fast=glm-5.3-flash',
    '--model-map', 'smart=glm-5.2',
    '--model-prefix', 'p1-',
    '--model-prefix', 'p2-',
    '--session-header', 'X-Custom-Session',
    '--session-field', 'meta.chat_id',
    '--path-rewrite', '^/v1/=>/zen/go/v1/',
    '--path-rewrite', '/responses$/=>/chat/completions',
  ]);

  assert.deepEqual(flags.inject.headers, { 'x-a': '1', 'x-b': '{{session.id}}' });
  assert.deepEqual(flags.model.map, { fast: 'glm-5.3-flash', smart: 'glm-5.2' });
  assert.deepEqual(flags.model.stripPrefixes, ['p1-', 'p2-']);
  assert.deepEqual(flags.session.headerNames, ['x-custom-session'], '头名应当统一小写');
  assert.deepEqual(flags.session.bodyFields, ['meta.chat_id']);
  assert.deepEqual(flags.request.pathRewrite, [
    { pattern: '^/v1/', replacement: '/zen/go/v1/' },
    { pattern: '/responses$/', replacement: '/chat/completions' },
  ]);
});

test('parseArgv 处理开关型与注入型参数', () => {
  const { flags } = parseArgv([
    '--no-session',
    '--no-stream',
    '--body-inject', 'temperature=0.2',
    '--body-inject', 'metadata.trace={{uuid}}',
    '--session-id-format', 'uuid',
    '--request-id-format', 'req-{{session.count}}',
    '--timeout', '120000',
    '--max-body', '1024',
    '--log-level', 'debug',
    '--log-file', './x.log',
    '--base-path', '/zen/go/v1',
  ]);

  assert.equal(flags.session.enabled, false);
  assert.equal(flags.response.stream, false);
  assert.deepEqual(flags.inject.body, { temperature: '0.2', 'metadata.trace': '{{uuid}}' });
  assert.equal(flags.session.idFormat, 'uuid');
  assert.equal(flags.session.requestIdFormat, 'req-{{session.count}}');
  assert.equal(flags.request.timeoutMs, 120000);
  assert.equal(flags.request.maxBodyBytes, 1024);
  assert.equal(flags.log.level, 'debug');
  assert.equal(flags.log.file, './x.log');
  assert.equal(flags.upstream.basePath, '/zen/go/v1');
});

test('parseArgv 识别本地工具开关', () => {
  assert.deepEqual(parseArgv(['--help']), { help: true });
  assert.deepEqual(parseArgv(['-h']), { help: true });
  assert.deepEqual(parseArgv(['--version']), { version: true });
  assert.deepEqual(parseArgv(['-v']), { version: true });

  const initWithPath = parseArgv(['--init', 'my-config.json']);
  assert.equal(initWithPath.initRequested, true);
  assert.equal(initWithPath.initFile, 'my-config.json');

  const initDefault = parseArgv(['--init']);
  assert.equal(initDefault.initRequested, true);
  assert.equal(initDefault.initFile, null);

  const printed = parseArgv(['--print-config', '-c', './custom.json']);
  assert.equal(printed.printConfig, true);
  assert.equal(printed.configFile, './custom.json');
});

test('parseArgv 空参数返回全默认的空片段', () => {
  const parsed = parseArgv([]);
  assert.deepEqual(parsed.flags, {});
  assert.equal(parsed.configFile, null);
  assert.equal(parsed.printConfig, false);
  assert.equal(parsed.initRequested, false);
});

test('parseArgv 对非法输入给出可读错误', () => {
  assert.throws(() => parseArgv(['--nope']), /无法识别的参数/);
  assert.throws(() => parseArgv(['stray']), /无法识别的参数/);
  assert.throws(() => parseArgv(['--port']), /缺少取值/);
  assert.throws(() => parseArgv(['--port', '--host']), /缺少取值/);
  assert.throws(() => parseArgv(['--inject', 'no-equals']), /name=value/);
  assert.throws(() => parseArgv(['--body-inject', 'no-equals']), /key=value/);
  assert.throws(() => parseArgv(['--model-map', 'only-alias']), /alias=real/);
  assert.throws(() => parseArgv(['--path-rewrite', 'no-arrow']), /正则=>替换/);
});

test('CLI --version 输出语义化版本号', () => {
  assert.match(runCli(['--version']).trim(), /^\d+\.\d+\.\d+$/);
});

test('CLI --help 打印用法并覆盖关键选项', () => {
  const output = runCli(['--help']);
  for (const flag of ['--inject', '--model-prefix', '--path-rewrite', '--print-config', '--init']) {
    assert.ok(output.includes(flag), `帮助里应当提到 ${flag}`);
  }
});

test('CLI --print-config 输出可解析的 JSON，且命令行覆盖生效', () => {
  const config = JSON.parse(runCli(['--print-config', '-p', '4321', '--inject', 'x-a=1']));

  assert.equal(config.listen.port, 4321);
  assert.equal(config.upstream.host, 'opencode.ai');
  assert.equal(config.inject.headers['x-a'], '1');
  assert.equal(config.__configPath, undefined, '内部字段不应出现在输出里');
});

test('CLI --init 生成的配置能被自己解析并用于启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-'));
  const target = path.join(dir, 'config.json');

  assert.match(runCli(['--init', target]), /已生成示例配置/);
  assert.ok(fs.existsSync(target));

  const config = JSON.parse(runCli(['--print-config', '-c', target]));
  assert.equal(config.session.enabled, true);
  assert.equal(config.model.stripPrefixes.includes('proxy-'), true);
});

test('CLI --init 不覆盖已存在的文件，并以非零码退出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-'));
  const target = path.join(dir, 'config.json');
  runCli(['--init', target]);

  assert.throws(
    () => execFileSync(process.execPath, [bin, '--init', target], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 1,
  );
});

test('CLI 对非法参数以退出码 2 结束', () => {
  assert.throws(
    () => execFileSync(process.execPath, [bin, '--bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 2,
  );
});

test('CLI 对非法配置以退出码 2 结束', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cli-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"listen":{"port":99999}}', 'utf8');

  assert.throws(
    () => execFileSync(process.execPath, [bin, '--print-config', '-c', bad], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => error.status === 2,
  );
});
