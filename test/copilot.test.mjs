import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COPILOT_CLIENT_ID,
  COPILOT_TOKEN_ENV,
  classifyToken,
  clearStoredCredential,
  createCopilotSessionManager,
  credentialFilePath,
  readStoredCredential,
  resolveGitHubToken,
  runDeviceFlow,
  tokenFromCommand,
  tokenFromEnv,
  writeStoredCredential,
} from '../src/copilot.js';

// ---------------------------------------------------------------- token 形态

test('classifyToken 认得官方支持的三种 token', () => {
  assert.deepEqual(classifyToken('github_pat_11ABCDEF'), { kind: 'fine-grained-pat', supported: true });
  assert.deepEqual(classifyToken('ghu_abc'), { kind: 'github-app-user', supported: true });
  assert.deepEqual(classifyToken('gho_abc'), { kind: 'oauth-user', supported: true });
});

test('classifyToken 明确标出 ghp_（classic PAT）已弃用', () => {
  // 官方 Copilot SDK 明确写了 ghp_ 不支持 —— 认出来就要说清楚，
  // 不能让人以为「配了个 PAT 就能用」
  assert.deepEqual(classifyToken('ghp_abc'), { kind: 'classic-pat', supported: false });
});

test('classifyToken 对空值与未知形态不乱猜', () => {
  assert.deepEqual(classifyToken(''), { kind: 'none', supported: false });
  assert.deepEqual(classifyToken(null), { kind: 'none', supported: false });
  assert.deepEqual(classifyToken('some-random-string'), { kind: 'unknown', supported: true });
});

// ---------------------------------------------------------------- 环境变量

test('tokenFromEnv 按官方优先级读环境变量', () => {
  const env = { COPILOT_GITHUB_TOKEN: 'a', GH_TOKEN: 'b', GITHUB_TOKEN: 'c' };
  assert.equal(tokenFromEnv(env).token, 'a');
  assert.equal(tokenFromEnv({ GH_TOKEN: 'b', GITHUB_TOKEN: 'c' }).token, 'b');
  assert.equal(tokenFromEnv({ GITHUB_TOKEN: 'c' }).token, 'c');
  assert.equal(tokenFromEnv({}), null);
});

test('tokenFromEnv 会跳过空串与纯空白', () => {
  const env = { COPILOT_GITHUB_TOKEN: '   ', GH_TOKEN: 'real' };
  assert.equal(tokenFromEnv(env).token, 'real');
});

test('COPILOT_TOKEN_ENV 就是官方那三个变量，顺序不能乱', () => {
  assert.deepEqual(COPILOT_TOKEN_ENV, ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
});

// ---------------------------------------------------------------- 命令取 token

test('tokenFromCommand 拿命令的 stdout 当 token', async () => {
  const result = await tokenFromCommand('node -e process.stdout.write("cmd-token")');
  assert.equal(result.token, 'cmd-token');
  assert.equal(result.source, 'command');
});

test('tokenFromCommand 在命令不存在时返回 null 而不是抛错', async () => {
  assert.equal(await tokenFromCommand('definitely-not-a-real-command-xyz'), null);
});

test('tokenFromCommand 在命令输出为空时返回 null', async () => {
  assert.equal(await tokenFromCommand('node -e process.stdout.write("")'), null);
});

// ---------------------------------------------------------------- 凭据文件

test('凭据文件的落点跟着 LSP_HOME 走', () => {
  const custom = credentialFilePath({ LSP_HOME: '/tmp/lsp-home' });
  assert.ok(custom.includes('lsp-home'));
  assert.ok(custom.endsWith('copilot-credentials.json'));
});

test('凭据文件不存在时 readStoredCredential 返回 null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    assert.equal(readStoredCredential({ LSP_HOME: home }), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('写进去再读出来，token 原样回来', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    writeStoredCredential('stored-token', { LSP_HOME: home });
    const loaded = readStoredCredential({ LSP_HOME: home });
    assert.equal(loaded.token, 'stored-token');
    assert.equal(loaded.source, 'file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('凭据文件内容坏了也不抛错，只当没存过', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    fs.mkdirSync(path.join(home), { recursive: true });
    fs.writeFileSync(path.join(home, 'copilot-credentials.json'), '{not json');
    assert.equal(readStoredCredential({ LSP_HOME: home }), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('clearStoredCredential 删掉文件，删过再删也不报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    writeStoredCredential('x', { LSP_HOME: home });
    assert.equal(clearStoredCredential({ LSP_HOME: home }), true);
    // 已经没有文件了 —— 不该抛错，返回 false 表示「本来就没有」
    assert.equal(clearStoredCredential({ LSP_HOME: home }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 凭据链

test('resolveGitHubToken 优先用 provider 点名的环境变量', async () => {
  const env = { MY_TOKEN: 'mine', GH_TOKEN: 'official' };
  const found = await resolveGitHubToken({ env, envNames: ['MY_TOKEN'], allowCommand: false });
  assert.equal(found.token, 'mine');
  assert.equal(found.source, 'env:MY_TOKEN');
});

test('resolveGitHubToken 点名的变量没有值时退回官方链', async () => {
  const env = { GH_TOKEN: 'official' };
  const found = await resolveGitHubToken({ env, envNames: ['MY_TOKEN'], allowCommand: false });
  assert.equal(found.token, 'official');
});

test('resolveGitHubToken 在 allowCommand 为 false 时不去问命令', async () => {
  // 必须给一个隔离的 LSP_HOME：否则 credentialFilePath 会落到用户真实的
  // ~/.lsp/copilot-credentials.json，测试结果取决于用户家目录里有没有这个文件。
  // 那不是「测试失败」，是**测试跑到用户数据上去了**——必须隔离。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    const found = await resolveGitHubToken({
      env: { LSP_HOME: home },
      allowCommand: false,
      command: 'node -e process.stdout.write("from-cmd")',
    });
    assert.equal(found, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveGitHubToken 能从自定义命令里取 token', async () => {
  // 同样要隔离 LSP_HOME：命令没取到时这条链会继续去读凭据文件，
  // 而凭据文件的默认位置是用户真实的 ~/.lsp。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    const found = await resolveGitHubToken({
      env: { LSP_HOME: home },
      command: 'node -e process.stdout.write("from-cmd")',
    });
    assert.equal(found.token, 'from-cmd');
    assert.equal(found.source, 'command');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveGitHubToken 读落盘的凭据文件', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    writeStoredCredential('from-file', { LSP_HOME: home });
    const found = await resolveGitHubToken({ env: { LSP_HOME: home }, allowCommand: false });
    assert.equal(found.token, 'from-file');
    assert.equal(found.source, 'file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveGitHubToken 里 gh CLI 排在凭据文件之前', async () => {
  // 活的登录态比存档更该优先——两者都有时取 gh CLI 的。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-cred-'));
  try {
    writeStoredCredential('from-file', { LSP_HOME: home });
    const found = await resolveGitHubToken({
      env: { LSP_HOME: home },
      command: 'node -e process.stdout.write("from-cmd")',
    });
    assert.equal(found.token, 'from-cmd');
    assert.equal(found.source, 'command');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveGitHubToken 什么都拿不到时返回 null', async () => {
  const found = await resolveGitHubToken({ env: { LSP_HOME: '/tmp/lsp-empty-xyz' }, allowCommand: false });
  assert.equal(found, null);
});

test('resolveGitHubToken 默认不触发设备流登录', async () => {
  // 设备流需要人参与，默认必须关着——否则一次普通请求会突然弹出登录流程。
  const found = await resolveGitHubToken({ env: { LSP_HOME: '/tmp/lsp-empty-xyz' }, allowCommand: false });
  assert.equal(found, null);
});

// ---------------------------------------------------------------- 设备流登录

test('设备流登录把设备码交给回调，拿到 token 后存档', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-device-'));
  const seen = [];
  try {
    const found = await runDeviceFlow({
      env: { LSP_HOME: home },
      onDeviceCode: (info) => seen.push(info),
      // 设备流程的两步都注入假的：只验证编排与存档，不碰网络
      requestDevice: async () => ({ device_code: 'dev-123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device' }),
      pollDevice: async () => ({ token: 'gho_from_device', scope: 'read:user' }),
    });
    assert.equal(found.token, 'gho_from_device');
    assert.equal(found.source, 'device-flow');
    // 回调拿到的只有码和地址，没有 token
    assert.equal(seen.length, 1);
    assert.equal(seen[0].userCode, 'ABCD-1234');
    assert.equal(seen[0].verificationUri, 'https://github.com/login/device');
    // token 落盘了，下次直接读文件
    const stored = readStoredCredential({ LSP_HOME: home });
    assert.equal(stored.token, 'gho_from_device');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('设备流登录拿到的 token 会被 resolveGitHubToken 优先读到', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-device-'));
  try {
    await runDeviceFlow({
      env: { LSP_HOME: home },
      requestDevice: async () => ({ device_code: 'dev-123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device' }),
      pollDevice: async () => ({ token: 'gho_from_device', scope: 'read:user' }),
    });
    const found = await resolveGitHubToken({ env: { LSP_HOME: home }, allowCommand: false });
    assert.equal(found.token, 'gho_from_device');
    assert.equal(found.source, 'file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- session 管理器

test('session 管理器在取不到凭据时抛出可读的错误', async () => {
  const manager = createCopilotSessionManager({ env: { LSP_HOME: '/tmp/lsp-empty-xyz' } });
  await assert.rejects(
    () => manager.get({ allowCommand: false }),
    (error) => {
      assert.match(error.message, /GitHub token/);
      return true;
    },
  );
});

test('session 管理器按凭据来源分桶缓存，不同来源不串号', async () => {
  // 换 token 那一步注入假的：只验证缓存分桶，不碰网络
  const calls = [];
  const manager = createCopilotSessionManager({
    env: { A_TOKEN: 'a', B_TOKEN: 'b' },
    exchangeSession: async (githubToken) => {
      calls.push(githubToken);
      return { token: `session-for-${githubToken}`, expiresAt: Date.now() + 600000 };
    },
  });

  const a = await manager.get({ envNames: ['A_TOKEN'] });
  const b = await manager.get({ envNames: ['B_TOKEN'] });
  assert.equal(a.token, 'session-for-a');
  assert.equal(b.token, 'session-for-b');

  // 再取一次走缓存，不该再换
  const aAgain = await manager.get({ envNames: ['A_TOKEN'] });
  assert.equal(aAgain.token, 'session-for-a');
  assert.equal(calls.length, 2, '两次不同来源各换一次，重复取命中缓存');
});

test('session 管理器的 peek 不触发任何网络调用', () => {
  const manager = createCopilotSessionManager({ env: {} });
  assert.equal(manager.peek(), null);
  assert.equal(manager.peek({ envNames: ['X'] }), null);
});

test('session 管理器的 invalidate 清掉指定来源的缓存', async () => {
  const manager = createCopilotSessionManager({
    env: { A_TOKEN: 'a' },
    exchangeSession: async () => ({ token: 'session-a', expiresAt: Date.now() + 600000 }),
  });

  await manager.get({ envNames: ['A_TOKEN'] });
  assert.ok(manager.peek({ envNames: ['A_TOKEN'] }));

  manager.invalidate({ envNames: ['A_TOKEN'] });
  assert.equal(manager.peek({ envNames: ['A_TOKEN'] }), null);
});

test('session 管理器在 token 快过期时提前刷新', async () => {
  let clock = 1_000_000;
  let exchanges = 0;
  const manager = createCopilotSessionManager({
    env: { A_TOKEN: 'a' },
    now: () => clock,
    exchangeSession: async () => {
      exchanges += 1;
      // 有效期 30 分钟（与官方一致）
      return { token: `session-${exchanges}`, expiresAt: clock + 30 * 60 * 1000 };
    },
  });

  await manager.get({ envNames: ['A_TOKEN'] });
  assert.equal(exchanges, 1);

  // 过了 26 分钟：还在有效期内（离过期还有 4 分钟 > 5 分钟余量？不对，正好该刷新）
  clock += 26 * 60 * 1000;
  await manager.get({ envNames: ['A_TOKEN'] });
  assert.equal(exchanges, 2, '离过期不足 5 分钟就该换新的');
});

test('session 管理器把并发请求合并成一次交换', async () => {
  let exchanges = 0;
  const manager = createCopilotSessionManager({
    env: { A_TOKEN: 'a' },
    exchangeSession: async () => {
      exchanges += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { token: 'session', expiresAt: Date.now() + 600000 };
    },
  });

  const results = await Promise.all([
    manager.get({ envNames: ['A_TOKEN'] }),
    manager.get({ envNames: ['A_TOKEN'] }),
    manager.get({ envNames: ['A_TOKEN'] }),
  ]);
  assert.equal(exchanges, 1, '三个并发请求只换一次 token');
  assert.equal(results[0].token, results[2].token);
});

test('官方 client id 是公开的那个固定值', () => {
  // 官方 Copilot 客户端（VS Code 扩展）用的就是这一个
  assert.equal(COPILOT_CLIENT_ID, 'Iv1.b507a08c87ecfe98');
});
