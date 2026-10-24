import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  apiKeyFromCommand,
  credentialSources,
  resolveApiKey,
  resolveWire,
} from '../src/upstreams.js';

/**
 * 上游池的分支覆盖。
 *
 * upstreams.test.mjs 覆盖的是「归一化与选择」的形状，这里补的是**运行时取凭据**
 * 与**边缘输入**：
 * 命令取不到 key、命令被禁用、凭据来源怎么列、wire 判定的兜底。
 *
 * 判据统一：取不到凭据时返回 null（让上游回 401），**绝不**抛异常把代理带崩。
 */

// ---------------------------------------------------------------- 命令取凭据

// auth.command 按空白切 argv，不走 shell——所以脚本要写成独立文件，
// 命令串里不能带引号（引号不是 shell 语法，只会被当成字面参数）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-upstreams-'));
let scriptSeq = 0;

function script(body) {
  const file = path.join(tmpDir, `key-${scriptSeq++}.mjs`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test.after(() => {
  for (const name of fs.readdirSync(tmpDir)) {
    try {
      fs.unlinkSync(path.join(tmpDir, name));
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch {
    /* ignore */
  }
});

test('命令取凭据：stdout 就是 key', async () => {
  const file = script("process.stdout.write('secret-key');\n");
  const provider = { auth: { command: `${process.execPath} ${file}` } };
  assert.equal(await apiKeyFromCommand(provider), 'secret-key');
});

test('命令取凭据：输出两端的空白被去掉', async () => {
  const file = script("process.stdout.write('  padded  ');\n");
  const provider = { auth: { command: `${process.execPath} ${file}` } };
  assert.equal(await apiKeyFromCommand(provider), 'padded');
});

test('命令取凭据：命令不存在时返回 null，不抛异常', async () => {
  const provider = { auth: { command: 'definitely-not-a-real-command-xyz --flag' } };
  assert.equal(await apiKeyFromCommand(provider), null);
});

test('命令取凭据：退出码非 0 时返回 null', async () => {
  const file = script('process.exit(3);\n');
  const provider = { auth: { command: `${process.execPath} ${file}` } };
  assert.equal(await apiKeyFromCommand(provider), null);
});

test('命令取凭据：输出为空时返回 null', async () => {
  const file = script("process.stdout.write('');\n");
  const provider = { auth: { command: `${process.execPath} ${file}` } };
  assert.equal(await apiKeyFromCommand(provider), null);
});

test('命令取凭据：没有配 command 时返回 null', async () => {
  assert.equal(await apiKeyFromCommand({}), null);
  assert.equal(await apiKeyFromCommand({ auth: {} }), null);
  assert.equal(await apiKeyFromCommand({ auth: { command: '   ' } }), null);
  assert.equal(await apiKeyFromCommand({ auth: { command: 123 } }), null);
});

test('命令取凭据：allowCommand=false 时不执行命令', async () => {
  const file = script("process.stdout.write('nope');\n");
  const provider = { auth: { command: `${process.execPath} ${file}`, allowCommand: false } };
  assert.equal(await apiKeyFromCommand(provider), null);
});

test('命令取凭据：超时算取不到，不抛异常', async () => {
  const file = script('setTimeout(() => {}, 5000);\n');
  const provider = { auth: { command: `${process.execPath} ${file}` } };
  assert.equal(await apiKeyFromCommand(provider, { timeoutMs: 120 }), null);
});

test('命令取凭据：命令按空白切 argv，不做 shell 展开', async () => {
  // 引号不是 shell 语法——整串会作为一个字面参数传给脚本
  const file = script('process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const provider = { auth: { command: `${process.execPath} ${file} a b` } };
  const value = await apiKeyFromCommand(provider);
  assert.deepEqual(JSON.parse(value), ['a', 'b']);
});

// ---------------------------------------------------------------- resolveApiKey

test('resolveApiKey：环境变量优先于命令', async () => {
  const file = script("process.stdout.write('from-command');\n");
  const provider = { auth: { env: 'MY_KEY', command: `${process.execPath} ${file}` } };
  const result = await resolveApiKey(provider, { env: { MY_KEY: 'from-env' } });
  assert.equal(result.value, 'from-env');
  assert.equal(result.source, 'env:MY_KEY');
});

test('resolveApiKey：环境变量为空时回落到命令', async () => {
  const file = script("process.stdout.write('from-command');\n");
  const provider = { auth: { env: 'MY_KEY', command: `${process.execPath} ${file}` } };
  const result = await resolveApiKey(provider, { env: { MY_KEY: '' } });
  assert.equal(result.value, 'from-command');
  assert.equal(result.source, 'command');
});

test('resolveApiKey：两个来源都没有时返回 null', async () => {
  assert.equal(await resolveApiKey({ auth: {} }, { env: {} }), null);
  assert.equal(await resolveApiKey({}, { env: {} }), null);
});

test('resolveApiKey：env 名里有多个候选时来源报第一个', async () => {
  const provider = { auth: { env: 'FIRST, SECOND' } };
  const result = await resolveApiKey(provider, { env: { FIRST: 'a', SECOND: 'b' } });
  assert.equal(result.value, 'a');
  assert.equal(result.source, 'env:FIRST');
});

test('resolveApiKey：env 名全为空时取不到凭据', async () => {
  // 候选名解析出来是空的 → 一个都取不到
  const provider = { auth: { env: ' , ' } };
  assert.equal(await resolveApiKey(provider, { env: { MY_KEY: 'x' } }), null);
});

// ---------------------------------------------------------------- 凭据来源列举

test('凭据来源：命令被列出来', () => {
  const sources = credentialSources({ auth: { command: 'op read op://vault/item/credential' } });
  assert.deepEqual(sources, [{ kind: 'command', command: 'op read op://vault/item/credential' }]);
});

test('凭据来源：设备流被列出来', () => {
  const sources = credentialSources({ auth: { deviceFlow: true } });
  assert.deepEqual(sources, [{ kind: 'deviceFlow' }]);
});

test('凭据来源：设备流为 false 时不列', () => {
  const sources = credentialSources({ auth: { deviceFlow: false } });
  assert.deepEqual(sources, []);
});

test('凭据来源：环境变量、命令、设备流按顺序全列出来', () => {
  const sources = credentialSources({
    auth: { env: 'A, B', command: 'read-key', deviceFlow: true },
  });
  assert.deepEqual(sources, [
    { kind: 'env', name: 'A' },
    { kind: 'env', name: 'B' },
    { kind: 'command', command: 'read-key' },
    { kind: 'deviceFlow' },
  ]);
});

test('凭据来源：provider 不合法时返回空数组', () => {
  assert.deepEqual(credentialSources(null), []);
  assert.deepEqual(credentialSources('x'), []);
  assert.deepEqual(credentialSources({}), []);
});

// ---------------------------------------------------------------- wire 判定

test('wire：provider 既没声明 wire 也没 modelWire 时兜底成 chat', () => {
  const result = resolveWire({ type: 'openai' }, 'gpt-4o');
  assert.equal(result.wire, 'chat');
  assert.equal(result.source, 'default');
});

test('wire：provider 声明了 wire 列表时取第一个', () => {
  const result = resolveWire({ type: 'openai', wire: ['responses', 'chat'] }, 'gpt-4o');
  assert.equal(result.wire, 'responses');
  assert.equal(result.source, 'provider');
});
