import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  exchangeSessionToken,
  pollDeviceToken,
  requestDeviceCode,
  tokenFromGhCli,
} from '../src/copilot.js';

/**
 * 起一个本地 mock server，按路径返回脚本化的响应。
 *
 * 用 http 而不是 https：一是端点可注入，二是本地 mock 不该依赖 TLS 证书。
 * 每个 handler 返回 { status, body } 或者一个函数（拿到 req 就能读 body）。
 */
async function startMock(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let result;
      try {
        result = handler(req, raw);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error?.message || error));
        return;
      }
      if (result === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const status = result.status ?? 200;
      const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------- 换 session token

test('exchangeSessionToken 换到 session token 并算出过期时间', async () => {
  const mock = await startMock(() => ({
    body: { token: 'sess-abc', expires_at: 1800000000 },
  }));
  try {
    const result = await exchangeSessionToken('gho_x', { endpoint: mock.url('/token') });
    assert.equal(result.token, 'sess-abc');
    assert.equal(result.expiresAt, 1800000000 * 1000);
  } finally {
    await mock.close();
  }
});

test('exchangeSessionToken 把 GitHub token 放进 Authorization 头', async () => {
  let seen = null;
  const mock = await startMock((req) => {
    seen = { auth: req.headers.authorization, apiVersion: req.headers['x-github-api-version'] };
    return { body: { token: 'sess-abc' } };
  });
  try {
    await exchangeSessionToken('gho_secret', { endpoint: mock.url('/token') });
    assert.equal(seen.auth, 'Bearer gho_secret');
    assert.equal(seen.apiVersion, '2022-11-28');
  } finally {
    await mock.close();
  }
});

test('exchangeSessionToken 缺 expires_at 时按 30 分钟估', async () => {
  const mock = await startMock(() => ({ body: { token: 'sess-abc' } }));
  try {
    const before = Date.now();
    const result = await exchangeSessionToken('gho_x', { endpoint: mock.url('/token') });
    assert.ok(result.expiresAt >= before + 29 * 60 * 1000);
    assert.ok(result.expiresAt <= Date.now() + 31 * 60 * 1000);
  } finally {
    await mock.close();
  }
});

test('exchangeSessionToken 上游非 200 时报出状态码', async () => {
  const mock = await startMock(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  try {
    await assert.rejects(
      () => exchangeSessionToken('gho_x', { endpoint: mock.url('/token') }),
      /401/,
    );
  } finally {
    await mock.close();
  }
});

test('exchangeSessionToken 返回的不是 JSON 时报错', async () => {
  const mock = await startMock(() => ({ status: 200, body: '<html>oops</html>' }));
  try {
    await assert.rejects(
      () => exchangeSessionToken('gho_x', { endpoint: mock.url('/token') }),
      /JSON/,
    );
  } finally {
    await mock.close();
  }
});

test('exchangeSessionToken 响应里没有 token 字段时报错', async () => {
  const mock = await startMock(() => ({ body: { nope: 1 } }));
  try {
    await assert.rejects(
      () => exchangeSessionToken('gho_x', { endpoint: mock.url('/token') }),
      /token/,
    );
  } finally {
    await mock.close();
  }
});

test('exchangeSessionToken 连不上时把网络错误抛出来', async () => {
  // 指向一个没人监听的端口
  await assert.rejects(
    () => exchangeSessionToken('gho_x', { endpoint: 'http://127.0.0.1:1/token', timeoutMs: 2000 }),
    (error) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
});

// ---------------------------------------------------------------- 设备码

test('requestDeviceCode 拿到设备码并带上 client_id 与 scope', async () => {
  let seen = null;
  const mock = await startMock((req, raw) => {
    seen = JSON.parse(raw);
    return {
      body: {
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    };
  });
  try {
    const result = await requestDeviceCode({ endpoint: mock.url('/login/device/code'), scope: 'read:user' });
    assert.equal(result.device_code, 'dev-1');
    assert.equal(result.user_code, 'ABCD-1234');
    assert.equal(seen.client_id, 'Iv1.b507a08c87ecfe98');
    assert.equal(seen.scope, 'read:user');
  } finally {
    await mock.close();
  }
});

test('requestDeviceCode 上游非 200 时报出状态码', async () => {
  const mock = await startMock(() => ({ status: 503, body: { error: 'busy' } }));
  try {
    await assert.rejects(
      () => requestDeviceCode({ endpoint: mock.url('/login/device/code') }),
      /503/,
    );
  } finally {
    await mock.close();
  }
});

test('requestDeviceCode 返回的不是 JSON 时报错', async () => {
  const mock = await startMock(() => ({ status: 200, body: 'not json at all' }));
  try {
    await assert.rejects(
      () => requestDeviceCode({ endpoint: mock.url('/login/device/code') }),
      /JSON/,
    );
  } finally {
    await mock.close();
  }
});

test('requestDeviceCode 响应里没有 device_code 时报错', async () => {
  const mock = await startMock(() => ({ body: { user_code: 'ABCD-1234' } }));
  try {
    await assert.rejects(
      () => requestDeviceCode({ endpoint: mock.url('/login/device/code') }),
      /device_code/,
    );
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- 轮询设备流

test('pollDeviceToken 拿到 access_token', async () => {
  let seen = null;
  const mock = await startMock((req, raw) => {
    seen = JSON.parse(raw);
    return { body: { access_token: 'gho_device', scope: 'read:user' } };
  });
  try {
    const result = await pollDeviceToken('dev-1', { endpoint: mock.url('/login/oauth/access_token') });
    assert.equal(result.token, 'gho_device');
    assert.equal(result.scope, 'read:user');
    assert.equal(seen.device_code, 'dev-1');
    assert.equal(seen.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  } finally {
    await mock.close();
  }
});

test('pollDeviceToken 在 authorization_pending 时继续轮询', async () => {
  let calls = 0;
  const mock = await startMock(() => {
    calls += 1;
    if (calls < 3) return { body: { error: 'authorization_pending' } };
    return { body: { access_token: 'gho_device' } };
  });
  try {
    const result = await pollDeviceToken('dev-1', {
      endpoint: mock.url('/login/oauth/access_token'),
      intervalMs: 1,
    });
    assert.equal(result.token, 'gho_device');
    assert.equal(calls, 3);
  } finally {
    await mock.close();
  }
});

test('pollDeviceToken 在 slow_down 时把间隔拉长再继续', async () => {
  let calls = 0;
  const mock = await startMock(() => {
    calls += 1;
    if (calls === 1) return { body: { error: 'slow_down' } };
    return { body: { access_token: 'gho_device' } };
  });
  try {
    const result = await pollDeviceToken('dev-1', {
      endpoint: mock.url('/login/oauth/access_token'),
      intervalMs: 1,
    });
    assert.equal(result.token, 'gho_device');
    assert.equal(calls, 2);
  } finally {
    await mock.close();
  }
});

test('pollDeviceToken 遇到别的错误直接失败，不无限重试', async () => {
  const mock = await startMock(() => ({ body: { error: 'access_denied' } }));
  try {
    await assert.rejects(
      () => pollDeviceToken('dev-1', { endpoint: mock.url('/login/oauth/access_token'), intervalMs: 1 }),
      /access_denied/,
    );
  } finally {
    await mock.close();
  }
});

test('pollDeviceToken 返回的不是 JSON 时报错', async () => {
  const mock = await startMock(() => ({ status: 200, body: 'nope' }));
  try {
    await assert.rejects(
      () => pollDeviceToken('dev-1', { endpoint: mock.url('/login/oauth/access_token'), intervalMs: 1 }),
      /JSON/,
    );
  } finally {
    await mock.close();
  }
});

test('pollDeviceToken 超过截止时间就放弃', async () => {
  const mock = await startMock(() => ({ body: { error: 'authorization_pending' } }));
  try {
    // now 每次调用都往后推，模拟时间流逝
    let tick = 0;
    const now = () => {
      tick += 1000;
      return tick;
    };
    await assert.rejects(
      () =>
        pollDeviceToken('dev-1', {
          endpoint: mock.url('/login/oauth/access_token'),
          intervalMs: 1,
          timeoutMs: 10,
          now,
        }),
      /timed out/,
    );
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- gh CLI

test('tokenFromGhCli 拿到 token', async () => {
  const found = await tokenFromGhCli('node', {
    args: ['-e', 'process.stdout.write("gho_from_gh")'],
  });
  assert.equal(found.token, 'gho_from_gh');
  assert.equal(found.source, 'command:gh');
});

test('tokenFromGhCli 命令不存在时返回 null', async () => {
  const found = await tokenFromGhCli('definitely-not-a-real-binary-xyz', { timeoutMs: 3000 });
  assert.equal(found, null);
});

test('tokenFromGhCli 输出为空时返回 null', async () => {
  const found = await tokenFromGhCli('node', { args: ['-e', 'process.stdout.write("")'] });
  assert.equal(found, null);
});
