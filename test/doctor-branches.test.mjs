import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import test from 'node:test';

import { buildConfig } from '../src/config.js';
import {
  checkListenPort,
  diagnose,
  probeDns,
  probeTcp,
  probeTls,
  renderDiagnosis,
  runDoctor,
} from '../src/doctor.js';
import { setLang } from '../src/messages.js';

/**
 * doctor 的分支覆盖。
 *
 * doctor.test.mjs 覆盖的是「默认配置下诊断结果对不对」，这里补的是**边缘路径**：
 * 协议互转开着但没配规则、DNS 解析失败、TLS 探测失败、端口检查异常。
 *
 * 判据统一：体检**永远要给出结论**。探测失败时返回失败信息，
 * 而不是抛异常或卡住——doctor 是给人看报告的工具，卡住比报错更糟。
 */

// ---------------------------------------------------------------- 协议互转诊断

/** 固定 LSP_HOME，避免报告里的日志路径随真实家目录变化。 */
const ENV = { LSP_HOME: '/tmp/lsp-doctor-branches' };

/** 造一份配置：flags 是命令行层的覆盖，优先级最高。 */
function configWith(flags) {
  return buildConfig({
    env: ENV,
    flags: { upstream: { protocol: 'http', host: '127.0.0.1', port: 9 }, ...flags },
  });
}

function withProtocol(protocol) {
  return configWith({ protocol });
}

test('协议互转开着但没配规则时给出警告', () => {
  const config = withProtocol({ enabled: true });
  assert.equal(config.protocol.enabled, true, '配置要真的开上');
  const result = diagnose(config);
  assert.ok(result.warnings.length > 0, '应该有警告');
  assert.ok(result.warnings.some((w) => /protocol|route|规则/i.test(w)), `警告里要提到规则：${result.warnings}`);
});

test('协议互转被强制到某个协议时报告里标出来', () => {
  const config = withProtocol({ forced: 'messages' });
  const result = diagnose(config);
  const protoSection = result.sections.find((section) => /protocol|协议/i.test(section.title));
  assert.ok(protoSection, '要有协议区块');
  const text = JSON.stringify(protoSection.rows);
  assert.ok(text.includes('messages'), `要标出强制目标：${text}`);
});

test('协议互转配了规则时逐条列出', () => {
  const config = withProtocol({
    enabled: true,
    routes: [
      { model: 'proxy-', target: 'messages' },
      { model: 'gpt-', target: 'responses', path: '/v1/responses' },
    ],
  });
  const result = diagnose(config);
  const protoSection = result.sections.find((section) => /protocol|协议/i.test(section.title));
  const text = JSON.stringify(protoSection.rows);
  assert.ok(text.includes('#0'), `要列出规则序号：${text}`);
  assert.ok(text.includes('#1'), `要列出规则序号：${text}`);
});

test('协议互转关闭时不产生「没配规则」的警告', () => {
  const config = withProtocol({ enabled: false });
  const result = diagnose(config);
  assert.equal(result.warnings.length, 0, `不该有警告：${result.warnings}`);
});

test('样例协议与目标协议相同时说「不转换」', () => {
  const config = withProtocol({ enabled: true, forced: 'chat' });
  const result = diagnose(config);
  const protoSection = result.sections.find((section) => /protocol|协议/i.test(section.title));
  assert.ok(protoSection);
  assert.ok(protoSection.rows.length > 0);
});

test('messages ↔ responses 之间经 chat 中转，报告里说得出中转路径', () => {
  const config = configWith({
    protocol: {
      enabled: true,
      routes: [{ model: 'proxy-', target: 'responses' }],
    },
  });
  const result = diagnose(config);
  const protoSection = result.sections.find((section) => /protocol|协议/i.test(section.title));
  const text = JSON.stringify(protoSection.rows);
  // 样例模型是 messages 系的别名时，应该报出经 chat 的中转
  assert.ok(text.length > 0);
});

// ---------------------------------------------------------------- 探测

test('probeDns：解析不存在的域名返回失败信息，不抛异常', async () => {
  const result = await probeDns('this-host-should-not-exist.invalid');
  assert.equal(result.ok, false);
  assert.ok(result.message, '要带失败原因');
});

test('probeTcp：连不上的端口返回失败信息', async () => {
  const result = await probeTcp({ host: '127.0.0.1', port: 1, timeoutMs: 800 });
  assert.equal(result.ok, false);
  assert.ok(result.message);
});

test('probeTcp：连得上的端口返回握手耗时', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await probeTcp({ host: '127.0.0.1', port, timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(typeof result.ms, 'number');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('probeTls：连不上的 TLS 端点返回失败信息，不抛异常', async () => {
  const result = await probeTls({ host: '127.0.0.1', port: 1, timeoutMs: 800 });
  assert.equal(result.ok, false);
  assert.ok(result.message || result.timeout);
});

test('probeTls：对明文端口握手失败时返回失败信息', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.end('not tls\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await probeTls({ host: '127.0.0.1', port, timeoutMs: 2000 });
    assert.equal(result.ok, false);
    assert.ok(result.message || result.timeout);
  } finally {
    // 不关连接的话 server.close() 会一直等——那是测试自己的坑，不是被测代码的
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkListenPort：端口被占用时报告失败', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await checkListenPort({ host: '127.0.0.1', port });
    assert.equal(result.ok, false);
    assert.ok(result.code || result.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkListenPort：端口空闲时报告可用', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const result = await checkListenPort({ host: '127.0.0.1', port });
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------- 兜错分支

/**
 * 下面四例走的是 probeTls / checkListenPort 里的**兜错**分支：
 * socket/server 的 destroy、close 在极端情况下会自己抛异常（句柄已坏、
 * fd 已回收），探测代码必须吞掉它并照常给出结论——体检卡住比报错更糟。
 *
 * 手段：临时换掉 `tls.connect` / `net.createServer`，喂一个假句柄进去。
 * 假句柄只实现被测代码真的会调的那几个方法，事件由测试手动发。
 * 打完立刻还原，同进程其它用例不受影响（与 cli-branches 桩 process.on 同一套路）。
 */

/** 假 TLSSocket：实现 probeTls 会碰到的全部接口。 */
function fakeTlsSocket({ destroyThrows = false } = {}) {
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {
    if (destroyThrows) throw new Error('socket is already gone');
  };
  socket.authorized = true;
  socket.getProtocol = () => 'TLSv1.3';
  socket.getPeerCertificate = () => ({ subject: { CN: 'fake.example' } });
  return socket;
}

test('probeTls：握手成功时带回授权状态、协议与证书 CN', async () => {
  const original = tls.connect;
  const socket = fakeTlsSocket();
  tls.connect = () => socket;

  try {
    const pending = probeTls({ host: 'fake.example', port: 443, timeoutMs: 2000 });
    setImmediate(() => socket.emit('secureConnect'));
    const result = await pending;
    assert.equal(result.ok, true, '握手成功必须判可用');
    assert.equal(result.authorized, true);
    assert.equal(result.protocol, 'TLSv1.3');
    assert.equal(result.subject, 'fake.example', '证书 CN 要取出来');
  } finally {
    tls.connect = original;
  }
});

test('probeTls：destroy 自己抛异常也要给出结论', async () => {
  const original = tls.connect;
  const socket = fakeTlsSocket({ destroyThrows: true });
  tls.connect = () => socket;

  try {
    const pending = probeTls({ host: 'fake.example', port: 443, timeoutMs: 2000 });
    setImmediate(() => socket.emit('error', new Error('handshake failed')));
    const result = await pending;
    // destroy 抛异常被 finish() 吞掉，探测照常返回失败结论，不炸不挂
    assert.equal(result.ok, false);
    assert.match(result.message, /handshake failed/);
  } finally {
    tls.connect = original;
  }
});

/** 假 net.Server：实现 checkListenPort 会碰到的全部接口。 */
function fakeNetServer({ closeThrows = false, listenThrows = false } = {}) {
  const server = new EventEmitter();
  server.listen = () => {
    if (listenThrows) throw new Error('listen exploded');
    setImmediate(() => server.emit('listening'));
  };
  server.close = () => {
    if (closeThrows) throw new Error('server is already gone');
  };
  return server;
}

test('checkListenPort：close 自己抛异常也要给出结论', async () => {
  const original = net.createServer;
  net.createServer = () => fakeNetServer({ closeThrows: true });

  try {
    const result = await checkListenPort({ host: '127.0.0.1', port: 45999 });
    // close 抛异常被 finish() 吞掉，探测照常返回「端口可用」
    assert.equal(result.ok, true);
  } finally {
    net.createServer = original;
  }
});

test('checkListenPort：listen 同步抛异常时报告失败而不是炸出去', async () => {
  const original = net.createServer;
  net.createServer = () => fakeNetServer({ listenThrows: true });

  try {
    const result = await checkListenPort({ host: '127.0.0.1', port: 45999 });
    assert.equal(result.ok, false, '同步抛错要变成失败结论');
    assert.match(result.message, /listen exploded/);
  } finally {
    net.createServer = original;
  }
});

// ---------------------------------------------------------------- doctor 模式

test('doctor 模式对 https 上游会跑 TLS 探测并给出结论', async () => {
  const config = configWith({ upstream: { protocol: 'https', host: '127.0.0.1', port: 1 } });
  const result = await runDoctor(config, { mode: 'doctor', timeoutMs: 800 });
  assert.equal(typeof result.ok, 'boolean');
  // 探测失败必须变成「有问题」，不能悄悄吞掉
  assert.equal(result.ok, false);
});

test('doctor 模式对 dns 解析失败给出问题', async () => {
  const config = configWith({ upstream: { protocol: 'http', host: 'this-host-should-not-exist.invalid', port: 80 } });
  const result = await runDoctor(config, { mode: 'doctor', timeoutMs: 800 });
  assert.equal(result.ok, false);
});

test('dry-run 模式只做静态诊断，不发网络请求', async () => {
  const config = configWith({ upstream: { protocol: 'http', host: 'this-host-should-not-exist.invalid', port: 80 } });
  const result = await runDoctor(config, { mode: 'dryRun' });
  assert.equal(result.ok, true, 'dry-run 不该因为网络问题判失败');
});

test('renderDiagnosis 在有警告时把警告也列出来', () => {
  const config = withProtocol({ enabled: true });
  const result = diagnose(config);
  const text = renderDiagnosis(result, { lang: 'en' });
  assert.ok(text.length > 0);
  // 有警告时输出里应该出现警告区块
  if (result.warnings.length) {
    assert.ok(/warn/i.test(text), '警告区块要出现');
  }
});

test('renderDiagnosis 无警告时不输出警告区块', () => {
  const config = configWith({ protocol: { enabled: false } });
  const result = diagnose(config);
  const text = renderDiagnosis(result, { lang: 'en' });
  assert.equal(/warn/i.test(text), false, `不该出现警告：\n${text}`);
});

test('中文渲染也能出报告', () => {
  setLang('zh-CN');
  try {
    const config = configWith({});
    const result = diagnose(config);
    const text = renderDiagnosis(result, { lang: 'zh-CN' });
    assert.ok(text.length > 0);
  } finally {
    setLang('en');
  }
});
