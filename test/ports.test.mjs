/**
 * 禁用端口（WHATWG bad ports）相关行为的测试。
 *
 * 这个模块的存在本身源于一次真实的排查：测试套件会间歇性失败，报一句没有原因的
 * `fetch failed`。把 `error.cause` 挖出来之后，原因清一色是 `Error bad port`——
 * OS 给 `listen(0)` 分配到了 6000 / 10080 / 5060 这类端口，而 undici 的 fetch
 * 按 WHATWG 规范在**发出请求之前**就把它拒了。代理走的是 node:http/https，
 * 完全不受这份名单约束，所以「服务端一切正常，客户端一个都连不上」。
 *
 * 这里钉住三件事：
 *   1. 清单与运行时内置 undici 的 badPortsSet 逐项一致（Node 升级改了名单会红）；
 *   2. 这些端口**真的**被 fetch 拒绝（不是只测常量）；
 *   3. 自动分配端口时能轮换掉它们，且显式配置的端口不被悄悄改掉。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { FORBIDDEN_PORTS, isForbiddenPort, listenUntilUsablePort } from '../src/ports.js';

/** 从当前运行时的内置 undici 源码里抽出坏端口名单；拿不到就返回 null。 */
function runtimeBadPorts() {
  try {
    const natives = process.binding('natives');
    const src = natives['internal/deps/undici/undici'];
    if (typeof src !== 'string') return null;
    const match = src.match(/var badPorts\s*=\s*\([\s\S]*?\[([\s\S]*?)\]\s*\)/);
    if (!match) return null;
    return match[1]
      .split(',')
      .map((item) => Number(item.trim().replace(/^["']|["']$/g, '')))
      .filter((port) => Number.isInteger(port));
  } catch {
    return null;
  }
}

test('清单形状：升序、唯一、正整数', () => {
  assert.ok(FORBIDDEN_PORTS.length > 0, '清单不能为空');
  for (const port of FORBIDDEN_PORTS) {
    assert.ok(Number.isInteger(port) && port > 0, `端口必须是正整数: ${port}`);
  }
  const sorted = [...FORBIDDEN_PORTS].sort((a, b) => a - b);
  assert.deepEqual(FORBIDDEN_PORTS, sorted, '清单应当是升序的，方便逐项比对');
  assert.equal(new Set(FORBIDDEN_PORTS).size, FORBIDDEN_PORTS.length, '清单里不该有重复端口');
});

test('清单与运行时内置 undici 的 badPortsSet 逐项一致', () => {
  const runtime = runtimeBadPorts();
  assert.ok(runtime, '没能从运行时源码里抽出 badPortsSet——测试环境不该如此');
  assert.equal(
    FORBIDDEN_PORTS.length,
    runtime.length,
    `清单条数与运行时不一致：本地 ${FORBIDDEN_PORTS.length}，运行时 ${runtime.length}`,
  );
  const missing = runtime.filter((port) => !FORBIDDEN_PORTS.includes(port));
  const extra = FORBIDDEN_PORTS.filter((port) => !runtime.includes(port));
  assert.deepEqual(missing, [], `清单漏了这些运行时禁用端口: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `清单多出这些运行时未禁用的端口: ${extra.join(', ')}`);
});

test('isForbiddenPort 只认整数的端口号', () => {
  for (const port of [1, 137, 6000, 6666, 10080]) {
    assert.equal(isForbiddenPort(port), true, `${port} 应当命中`);
  }
  // 0 = 让系统分配，不在清单内；9355 是本工具的默认端口，绝不能误伤
  for (const port of [0, 443, 8080, 9355, 65535, 65536, -1]) {
    assert.equal(isForbiddenPort(port), false, `${port} 不应当命中`);
  }
  for (const value of [undefined, null, '6000', 6000.5, NaN, {}, [], true]) {
    assert.equal(isForbiddenPort(value), false, `${String(value)} 不应当命中`);
  }
});

test('清单里的端口确实被 fetch 拒绝（bad port），而不是连不上', async () => {
  const results = await Promise.allSettled(
    FORBIDDEN_PORTS.map((port) => fetch(`http://127.0.0.1:${port}/x`, { signal: AbortSignal.timeout(4000) })),
  );
  const notBlocked = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      notBlocked.push(`${FORBIDDEN_PORTS[index]}(通了)`);
      return;
    }
    const cause = result.reason?.cause;
    const message = String(cause?.message || result.reason?.message || '');
    if (!/bad port/i.test(message)) notBlocked.push(`${FORBIDDEN_PORTS[index]}(${message})`);
  });
  assert.deepEqual(notBlocked, [], `这些端口没有被 fetch 以 bad port 拒绝: ${notBlocked.join(', ')}`);
});

test('对照组：非禁用端口连不上时报的是 ECONNREFUSED，不是 bad port', async () => {
  // 45999 不在清单里，本机也没人监听
  let message = '';
  try {
    await fetch('http://127.0.0.1:45999/x', { signal: AbortSignal.timeout(4000) });
    assert.fail('不该连得上');
  } catch (error) {
    message = String(error?.cause?.message || error?.message || '');
  }
  assert.ok(!/bad port/i.test(message), `对照组不应当报 bad port: ${message}`);
  assert.ok(/ECONNREFUSED|refused/i.test(message), `对照组应当报拒绝连接: ${message}`);
});

/** 按给定序列回放 listen 结果的假 server：每次 listen 弹出下一项。 */
function fakeServer(sequence) {
  const calls = { listen: 0, close: 0, closeAllConnections: 0 };
  const emitter = new EventEmitter();
  const server = {
    calls,
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
    address() {
      return server._address;
    },
    _address: null,
    listen(port, host, callback) {
      calls.listen += 1;
      const next = sequence[Math.min(calls.listen - 1, sequence.length - 1)];
      if (next instanceof Error) {
        process.nextTick(() => emitter.emit('error', next));
        return;
      }
      if (next && next.throwSync) throw next.throwSync;
      server._address = { address: '127.0.0.1', family: 'IPv4', port: next };
      process.nextTick(callback);
    },
    close(callback) {
      calls.close += 1;
      process.nextTick(callback);
    },
    closeAllConnections() {
      calls.closeAllConnections += 1;
    },
  };
  return server;
}

test('端口可用时一次 listen 就返回，不碰 close', async () => {
  const abandoned = [];
  const gaveUp = [];
  const server = fakeServer([8231]);
  const address = await listenUntilUsablePort(server, {
    port: 0,
    host: '127.0.0.1',
    onAbandon: (port) => abandoned.push(port),
    onGiveUp: (port) => gaveUp.push(port),
  });

  assert.equal(address.port, 8231);
  assert.equal(server.calls.listen, 1);
  assert.equal(server.calls.close, 0);
  assert.deepEqual(abandoned, []);
  assert.deepEqual(gaveUp, []);
});

test('自动分配撞上禁用端口时换一个，并逐个记名', async () => {
  const abandoned = [];
  const gaveUp = [];
  const server = fakeServer([6000, 10080, 8231]);
  const address = await listenUntilUsablePort(server, {
    port: 0,
    host: '127.0.0.1',
    onAbandon: (port) => abandoned.push(port),
    onGiveUp: (port) => gaveUp.push(port),
  });

  assert.equal(address.port, 8231, '最终端口必须脱离禁用清单');
  assert.equal(server.calls.listen, 3, '换了两次，一共 listen 三次');
  assert.equal(server.calls.close, 2, '每放弃一个端口都要 close 一次');
  assert.equal(server.calls.closeAllConnections, 2, 'close 之前要先收掉旧连接，否则 close 可能永远等下去');
  assert.deepEqual(abandoned, [6000, 10080], '被放弃的端口要按顺序记名');
  assert.deepEqual(gaveUp, []);
});

test('用户显式配置的端口不被悄悄改掉（哪怕在禁用清单里）', async () => {
  const abandoned = [];
  const server = fakeServer([6000]);
  const address = await listenUntilUsablePort(server, {
    port: 6000,
    host: '127.0.0.1',
    onAbandon: (port) => abandoned.push(port),
  });

  assert.equal(address.port, 6000);
  assert.equal(server.calls.listen, 1, '显式端口一次 listen 就返回');
  assert.equal(server.calls.close, 0);
  assert.deepEqual(abandoned, [], '不该尝试轮换');
});

test('轮换到上限仍躲不开时原样返回，并通知调用方', async () => {
  const gaveUp = [];
  const server = fakeServer([6000]);
  const address = await listenUntilUsablePort(server, {
    port: 0,
    host: '127.0.0.1',
    maxAttempts: 3,
    onGiveUp: (port) => gaveUp.push(port),
  });

  assert.equal(address.port, 6000);
  assert.equal(server.calls.listen, 3, '试满 maxAttempts 次就收手，不能无限循环');
  assert.deepEqual(gaveUp, [6000], '放弃时要让调用方知道');
});

test('listen 报错时原样 reject，不会吞掉启动失败', async () => {
  const server = fakeServer([new Error('EADDRINUSE')]);
  await assert.rejects(() => listenUntilUsablePort(server, { port: 0, host: '127.0.0.1' }), /EADDRINUSE/);
  assert.equal(server.calls.listen, 1);
});

test('listen 同步抛错时也 reject（Node 对非法 host 就是这么报的）', async () => {
  const server = fakeServer([{ throwSync: new Error('bad host') }]);
  await assert.rejects(() => listenUntilUsablePort(server, { port: 0, host: '127.0.0.1' }), /bad host/);
  // 同步抛错那条路径上，once('error') 的监听者必须被摘掉，否则会漏到后面的用例里
  assert.equal(server.listenerCount('error'), 0, '同步抛错后不应残留 error 监听者');
});

test('同一个 server 对象 close 之后可以再次 listen（轮换依赖这个行为）', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const first = await listenUntilUsablePort(server, { port: 0, host: '127.0.0.1' });
  assert.ok(first.port > 0);

  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  assert.equal(server.listening, false);

  const second = await listenUntilUsablePort(server, { port: 0, host: '127.0.0.1' });
  assert.ok(second.port > 0, 'close 之后应当还能再 listen');

  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

test('真实 server 自动分配端口时，落点永远不在禁用清单里', async () => {
  // 这是整个模块要保证的那件事：反复起停，统计有没有撞上禁用端口
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    const server = http.createServer((req, res) => res.end('ok'));
    const address = await listenUntilUsablePort(server, { port: 0, host: '127.0.0.1' });
    seen.push(address.port);
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
  const forbidden = seen.filter((port) => isForbiddenPort(port));
  assert.deepEqual(forbidden, [], `自动分配撞上了禁用端口: ${forbidden.join(', ')}`);
});
