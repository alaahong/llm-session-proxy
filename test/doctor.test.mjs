import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { buildConfig } from '../src/config.js';
import {
  checkListenPort,
  diagnose,
  explainModel,
  mapComposition,
  pickSampleModel,
  probeTcp,
  renderDiagnosis,
  runDoctor,
} from '../src/doctor.js';
import { DEFAULT_LANG, setLang } from '../src/messages.js';
import { DEFAULT_MODEL_MAP } from '../src/models.js';

/** 固定 LSP_HOME，避免体检报告里的日志路径随真实家目录变化。 */
const ENV = { LSP_HOME: '/tmp/lsp-doctor' };
const enConfig = () => buildConfig({ env: ENV, flags: {} });

/** 起一个真实在听的 TCP 服务，返回 { server, port, close }。 */
async function listenOnce() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('pickSampleModel 默认取映射表首条并补上第一个前缀', () => {
  const config = enConfig();
  const firstAlias = Object.keys(config.model.map)[0];

  assert.equal(pickSampleModel(config), `proxy-${firstAlias}`, '默认样例要覆盖「剥前缀 + 查映射」这条路径');
  assert.equal(pickSampleModel(config, 'proxy-custom'), 'proxy-custom', '显式指定优先');
  assert.equal(pickSampleModel({ model: { map: {}, stripPrefixes: [] } }), 'example-model');
  assert.equal(pickSampleModel({ model: { map: {}, stripPrefixes: ['proxy-'] } }), 'proxy-example-model');
});

test('explainModel 把四种结果分清楚', () => {
  const config = enConfig();

  const mapped = explainModel(config.model, 'proxy-glm');
  assert.equal(mapped.outcome, 'mapped');
  assert.equal(mapped.resolved, config.model.map.glm);
  assert.equal(mapped.strippedPrefix, 'proxy-');
  assert.equal(mapped.aliasKey, 'glm', '命中的是剥完前缀后的短别名');

  const passthrough = explainModel(config.model, 'glm-5.3');
  assert.equal(passthrough.outcome, 'passthrough', '没有前缀可剥就是正常透传');
  assert.equal(passthrough.resolved, 'glm-5.3');

  const unmapped = explainModel(config.model, 'proxy-nope');
  assert.equal(unmapped.outcome, 'stripped-unmapped');
  assert.equal(unmapped.resolved, 'nope', '剥了前缀但没有映射，会原样发出去');

  // model.default 只在「名字完全没被动过」时兜底；剥过前缀的不兜。
  // 这正是「proxy-xxx 被剥成 xxx 后原样发出去」的由来，值得钉住。
  const fallback = explainModel({ ...config.model, map: {}, default: 'fallback-model' }, 'unknown-model');
  assert.equal(fallback.outcome, 'default');
  assert.equal(fallback.resolved, 'fallback-model');

  const notRescued = explainModel({ ...config.model, map: {}, default: 'fallback-model' }, 'proxy-nope');
  assert.equal(notRescued.outcome, 'stripped-unmapped', 'model.default 不兜底「剥完前缀仍无映射」');
  assert.equal(notRescued.resolved, 'nope');
});

test('mapComposition 区分内置项与用户改写/新增项', () => {
  const config = enConfig();
  const builtinCount = Object.keys(DEFAULT_MODEL_MAP).length;

  assert.deepEqual(mapComposition(config.model), {
    total: builtinCount,
    builtin: builtinCount,
    overrides: 0,
  });

  const patched = {
    ...config.model,
    map: { ...config.model.map, glm: 'glm-custom', 'my-alias': 'my-model' },
  };
  const composition = mapComposition(patched);
  assert.equal(composition.overrides, 2, '改写内置键与新增键都算覆盖');
  assert.equal(composition.builtin + composition.overrides, composition.total);
});

test('diagnose 对默认配置给出完整分节，且没有问题也没有警告', () => {
  const diagnosis = diagnose(enConfig(), { env: ENV });

  assert.deepEqual(diagnosis.problems, []);
  assert.deepEqual(diagnosis.warnings, []);
  assert.deepEqual(
    diagnosis.sections.map((section) => section.title),
    ['Config', 'Upstream', 'Routing', 'Injection', 'Model', 'Router', 'Transformers', 'Protocol', 'Log'],
  );
  assert.equal(diagnosis.explanation.outcome, 'mapped');
});

test('diagnose 会把注入模板真的渲染一遍，而不是回显模板', () => {
  const diagnosis = diagnose(enConfig(), { env: ENV });
  const injection = diagnosis.sections.find((section) => section.title === 'Injection');
  const sessionRow = injection.rows.find(([, value]) => value.includes('x-opencode-session'));

  assert.ok(sessionRow, '应当列出 x-opencode-session 这一行');
  // 行格式是 `名字 = 模板  ->  渲染结果`，只取箭头右边来判断渲染是否真的发生了
  const rendered = sessionRow[1].split('->').pop().trim();
  assert.match(rendered, /^ses_[0-9a-z]+$/, `模板要渲染成真实样例值，实际是 ${rendered}`);
  assert.ok(!rendered.includes('{{'), '渲染结果里不该残留占位符');
  assert.ok(
    injection.rows.some(([, value]) => value.split('->').pop().includes('msg_1')),
    'requestId 模板也要渲染（msg_{{session.count}} -> msg_1）',
  );
});

test('显式点名一个解析不出来的别名算问题，退出判定为失败', async () => {
  const diagnosis = await runDoctor(enConfig(), { model: 'proxy-nope', env: ENV });

  assert.equal(diagnosis.problems.length, 1);
  assert.match(diagnosis.problems[0], /proxy-nope/);
  assert.match(diagnosis.problems[0], /nope/);
  assert.equal(diagnosis.ok, false);
});

test('映射表为空且启用了前缀剥离时给出警告（自动取样不升级为问题）', () => {
  const config = enConfig();
  const diagnosis = diagnose(
    { ...config, model: { ...config.model, map: {} } },
    { env: ENV },
  );

  assert.equal(diagnosis.explanation.outcome, 'stripped-unmapped');
  assert.equal(diagnosis.problems.length, 0, '自动取样的未命中只算警告，不该让体检失败');
  assert.equal(diagnosis.warnings.length, 2, '空映射表 + 剥完无映射各一条');
  assert.ok(diagnosis.warnings.some((line) => /model\.map is empty/.test(line)));
});

test('dry-run 模式不做任何网络检查', async () => {
  const diagnosis = await runDoctor(enConfig(), { mode: 'dryRun', env: ENV });

  assert.equal(diagnosis.checks, undefined, '不该有检查结果');
  assert.ok(!diagnosis.sections.some((section) => section.title === 'Checks'));
  assert.equal(diagnosis.ok, true);
});

test('probeTcp 对在听端口成功、对已关闭端口失败', async () => {
  const target = await listenOnce();

  const alive = await probeTcp({ host: '127.0.0.1', port: target.port, timeoutMs: 2000 });
  assert.equal(alive.ok, true);
  assert.ok(Number.isFinite(alive.ms), '应当给出握手耗时');

  await target.close();
  const dead = await probeTcp({ host: '127.0.0.1', port: target.port, timeoutMs: 2000 });
  assert.equal(dead.ok, false);
  assert.ok(dead.message || dead.timeout, '失败时要带上原因');
});

test('checkListenPort 能分辨端口空闲与占用', async () => {
  const free = await checkListenPort({ host: '127.0.0.1', port: 0 });
  assert.equal(free.ok, true, '端口 0 交给系统分配，永远可用');

  const busy = await listenOnce();
  const occupied = await checkListenPort({ host: '127.0.0.1', port: busy.port });
  await busy.close();

  assert.equal(occupied.ok, false);
  assert.equal(occupied.code, 'EADDRINUSE');
});

test('doctor 模式对本地可达上游判定通过', async () => {
  const upstream = await listenOnce();
  const config = buildConfig({
    env: ENV,
    flags: {
      upstream: { protocol: 'http', host: '127.0.0.1', port: upstream.port },
      listen: { port: 0 },
    },
  });

  const diagnosis = await runDoctor(config, { mode: 'doctor', env: ENV });
  await upstream.close();

  assert.ok(diagnosis.sections.some((section) => section.title === 'Checks'));
  assert.equal(diagnosis.problems.length, 0, diagnosis.problems.join('; '));
  assert.equal(diagnosis.ok, true);
  assert.ok(diagnosis.checks.some((line) => line.includes('tcp ok')));
  assert.ok(diagnosis.checks.some((line) => line.includes('is free')));

  const text = renderDiagnosis(diagnosis, { name: 'llm-session-proxy', version: '9.9.9' });
  assert.ok(text.includes('— doctor'), '标题里要标出当前是 doctor 模式');
  assert.ok(text.includes('OK — the configuration is valid and every check passed.'));
});

test('doctor 模式对连不上的上游端口判定失败并给出问题', async () => {
  const upstream = await listenOnce();
  const port = upstream.port;
  await upstream.close();

  const config = buildConfig({
    env: ENV,
    flags: { upstream: { protocol: 'http', host: '127.0.0.1', port } },
  });
  const diagnosis = await runDoctor(config, { mode: 'doctor', env: ENV });

  assert.equal(diagnosis.ok, false);
  assert.ok(
    diagnosis.problems.some((line) => line.includes(String(port))),
    `问题里应当带上端口号 ${port}: ${diagnosis.problems.join('; ')}`,
  );
});

test('renderDiagnosis 输出标题、分节与结果行，中英各自成篇', async () => {
  const en = await runDoctor(enConfig(), { env: ENV });
  const enText = renderDiagnosis(en, { name: 'llm-session-proxy', version: '9.9.9' });

  assert.ok(enText.startsWith('llm-session-proxy v9.9.9 — dry run'), enText.slice(0, 80));
  assert.ok(enText.includes('Result'));
  assert.ok(enText.includes('OK — the configuration is valid.'));
  assert.ok(!/\p{Script=Han}/u.test(enText), `英文体检报告里不应有中文:\n${enText}`);

  try {
    const zh = await runDoctor(buildConfig({ env: ENV, flags: { lang: 'zh' } }), { env: ENV });
    const zhText = renderDiagnosis(zh, { name: 'llm-session-proxy', version: '9.9.9' });

    assert.ok(zhText.startsWith('llm-session-proxy v9.9.9 —— 试运行'), zhText.slice(0, 80));
    assert.ok(zhText.includes('通过 —— 配置有效。'));
    assert.ok(zhText.includes('映射表'), '中文分节标题应当本地化');
  } finally {
    setLang(DEFAULT_LANG);
  }
});

test('renderDiagnosis 在有问题时给出 FAILED 结果行', async () => {
  const diagnosis = await runDoctor(enConfig(), { model: 'proxy-nope', env: ENV });
  const text = renderDiagnosis(diagnosis, { name: 'llm-session-proxy', version: '9.9.9' });

  assert.match(text, /FAILED/);
  assert.match(text, /1 problem\(s\)/);
});

// ---------- v0.2.1 路由与变换区块 ----------

function routerConfig(flags = {}) {
  return buildConfig({
    env: ENV,
    flags: {
      router: {
        enabled: true,
        buckets: {
          think: { model: 'glm-5.3-think', transformers: ['drop-empty-fields'] },
          longContext: { model: 'glm-5.3-long' },
        },
        rules: [
          { bucket: 'think', path: '/zen/go/v1/messages' },
          { bucket: 'longContext', minBytes: 60000 },
        ],
      },
      transformers: { enabled: ['noop'], options: {} },
      ...flags,
    },
  });
}

test('diagnose 会真的跑一遍路由，并列出桶与规则', () => {
  const diagnosis = diagnose(routerConfig(), { env: ENV });
  const router = diagnosis.sections.find((section) => section.title === 'Router');

  assert.ok(router, '应当有 Router 区块');
  const rows = router.rows.map(([label, value]) => `${label} :: ${value}`).join('\n');
  assert.match(rows, /enabled :: yes/);
  assert.match(rows, /default bucket :: default/);
  assert.match(rows, /bucket think :: model=glm-5\.3-think transformers=drop-empty-fields/);
  assert.match(rows, /bucket longContext :: model=glm-5\.3-long/);
  assert.match(rows, /#0 :: path\^=\/zen\/go\/v1\/messages -> think/);
  assert.match(rows, /#1 :: bytes>=60000 -> longContext/);
  // 默认样例模型是 proxy-glm，两条规则都不该命中
  assert.match(rows, /sample route :: default {2}\(default bucket/);
});

test('Transformers 区块区分全局、生效与可用三行', () => {
  const diagnosis = diagnose(routerConfig(), { env: ENV });
  const transformers = diagnosis.sections.find((section) => section.title === 'Transformers');
  const rows = Object.fromEntries(transformers.rows);

  assert.equal(rows.global, 'noop');
  // 样例落在 default 桶，而 default 桶没挂变换 → 生效的只有全局那一个
  assert.equal(rows.effective, 'noop');
  assert.match(rows.available, /^noop, drop-fields, drop-empty-fields, rename-fields, clamp-max-tokens$/);
});

test('样例请求命中规则时，生效变换会把桶挂的一并算上', () => {
  // 样例路径固定为 /v1/chat/completions，所以用 modelPrefix 把样例模型引到 think 桶
  const config = buildConfig({
    env: ENV,
    flags: {
      transformers: { enabled: ['noop'] },
      router: {
        enabled: true,
        buckets: { think: { transformers: ['drop-empty-fields'] } },
        rules: [{ bucket: 'think', modelPrefix: 'proxy-' }],
      },
    },
  });
  const diagnosis = diagnose(config, { env: ENV });
  const router = Object.fromEntries(
    diagnosis.sections.find((section) => section.title === 'Router').rows,
  );
  const transformers = Object.fromEntries(
    diagnosis.sections.find((section) => section.title === 'Transformers').rows,
  );

  assert.match(router['sample route'], /think {2}\(rule #0/);
  assert.equal(transformers.effective, 'noop, drop-empty-fields', '全局在前，桶的追加在后');
});

test('router 开启但什么都没配会给出警告', () => {
  const diagnosis = diagnose(buildConfig({ env: ENV, flags: { router: { enabled: true } } }), { env: ENV });

  assert.equal(diagnosis.warnings.length, 1);
  assert.match(diagnosis.warnings[0], /no rule and no bucket is configured/);
});

test('router 关闭时不产生这个警告，即使桶是空的', () => {
  const diagnosis = diagnose(enConfig(), { env: ENV });
  assert.deepEqual(diagnosis.warnings, []);
});

test('--router 强制桶会在报告里标出来', () => {
  const diagnosis = diagnose(buildConfig({ env: ENV, flags: { router: { forced: 'think' } } }), { env: ENV });
  const rows = Object.fromEntries(diagnosis.sections.find((section) => section.title === 'Router').rows);

  assert.match(rows.enabled, /forced to "think"/);
  assert.match(rows['sample route'], /think {2}\(forced by --router\)/);
});

test('中文报告里的新区块也成对出现，且不与既有的"路由"区块撞名', () => {
  const diagnosis = diagnose(routerConfig({ lang: 'zh' }), { env: ENV, model: 'proxy-glm' });
  const titles = diagnosis.sections.map((section) => section.title);

  // 既有的 Routing 区块在中文里叫「路由」，新的 Router 区块必须能区分开
  assert.ok(titles.includes('路由'), titles.join(','));
  assert.ok(titles.includes('路由分桶'), titles.join(','));
  assert.ok(titles.includes('变换'), titles.join(','));
  assert.equal(titles.filter((title) => title === '路由').length, 1, '区块标题不能重复');
  assert.equal(new Set(titles).size, titles.length, '所有区块标题必须互不相同');

  const router = diagnosis.sections.find((section) => section.title === '路由分桶');
  assert.ok(router.rows.some(([label]) => label === '样例路由'), router.rows.map(([l]) => l).join(','));
  // 规则行是 [「#序号」, 「<匹配式> -> <桶>」]，序号在标签列、桶在值列
  assert.ok(router.rows.some(([label]) => label === '#0'), '规则行要有序号标签');
  assert.ok(router.rows.some(([, value]) => value.includes('-> think')), '规则行要写明落进哪个桶');
  setLang(DEFAULT_LANG);
});
