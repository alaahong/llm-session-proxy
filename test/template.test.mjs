import assert from 'node:assert/strict';
import test from 'node:test';

import { builtinFunctions, createContext, renderDeep, renderTemplate } from '../src/template.js';

test('渲染嵌套路径与自定义函数', () => {
  const ctx = createContext({
    session: { id: 'ses_abc', count: 7, requestId: 'msg_7' },
    model: 'glm-5.3',
    header: { authorization: 'Bearer sk-1' },
    functions: { uuid: () => 'fixed-uuid' },
  });

  assert.equal(renderTemplate('{{session.id}}', ctx), 'ses_abc');
  assert.equal(renderTemplate('{{session.requestId}}/{{session.count}}', ctx), 'msg_7/7');
  assert.equal(renderTemplate('{{header.authorization}}', ctx), 'Bearer sk-1');
  assert.equal(renderTemplate('{{model}}', ctx), 'glm-5.3');
  assert.equal(renderTemplate('{{uuid}}', ctx), 'fixed-uuid');
});

test('带参内置函数按参数决定长度', () => {
  const ctx = createContext();
  assert.match(renderTemplate('{{randomHex:8}}', ctx), /^[0-9a-f]{8}$/);
  assert.match(renderTemplate('{{randomHex:32}}', ctx), /^[0-9a-f]{32}$/);
  assert.match(renderTemplate('{{random}}', ctx), /^[0-9a-f]{26}$/);
  assert.match(renderTemplate('{{randomBase36:12}}', ctx), /^[0-9a-z]{12}$/);
});

test('两次渲染随机函数得到不同结果，时间戳是数字', () => {
  const ctx = createContext();
  assert.notEqual(renderTemplate('{{randomHex:16}}', ctx), renderTemplate('{{randomHex:16}}', ctx));
  assert.match(renderTemplate('{{timestamp}}', ctx), /^\d{10}$/);
  assert.match(renderTemplate('{{timestampMs}}', ctx), /^\d{13}$/);
});

test('位置不存在时渲染成空串，而不是留下字面量', () => {
  const ctx = createContext({ session: { id: 'x' } });
  assert.equal(renderTemplate('{{session.missing}}', ctx), '');
  assert.equal(renderTemplate('{{nope.deep.path}}', ctx), '');
  assert.equal(renderTemplate('a{{notfound}}b', ctx), 'ab');
});

test('对象值序列化成 JSON', () => {
  const ctx = createContext({ payload: { a: 1, b: [2, 3] } });
  assert.equal(renderTemplate('{{payload}}', ctx), '{"a":1,"b":[2,3]}');
});

test('createContext 默认暴露 process.env', () => {
  const ctx = createContext();
  assert.equal(ctx.env, process.env);
  assert.equal(renderTemplate('{{env.PATH}}', ctx), process.env.PATH || '');
});

test('没有占位符的字符串原样返回且不做额外处理', () => {
  const ctx = createContext();
  assert.equal(renderTemplate('纯文本 {{ 单括号', ctx), '纯文本 {{ 单括号');
  assert.equal(renderTemplate('no placeholders', ctx), 'no placeholders');
  assert.equal(renderTemplate('', ctx), '');
});

test('非字符串输入原样返回', () => {
  const ctx = createContext();
  assert.equal(renderTemplate(42, ctx), 42);
  assert.equal(renderTemplate(null, ctx), null);
  assert.equal(renderTemplate(undefined, ctx), undefined);
});

test('renderDeep 递归渲染对象与数组，保留其他类型', () => {
  const ctx = createContext({ session: { id: 'ses_1' }, functions: { uuid: () => 'u1' } });
  const input = {
    session_id: '{{session.id}}',
    nested: { trace: '{{uuid}}', count: 3, flag: true, nothing: null },
    list: ['{{session.id}}', 5, { deep: '{{session.id}}-x' }],
  };
  const output = renderDeep(input, ctx);

  assert.equal(output.session_id, 'ses_1');
  assert.equal(output.nested.trace, 'u1');
  assert.equal(output.nested.count, 3);
  assert.equal(output.nested.flag, true);
  assert.equal(output.nested.nothing, null);
  assert.equal(output.list[0], 'ses_1');
  assert.equal(output.list[1], 5);
  assert.equal(output.list[2].deep, 'ses_1-x');
  assert.equal(input.session_id, '{{session.id}}', '不应修改输入对象');
});

test('builtinFunctions 全部返回字符串或数字，不抛错', () => {
  const fns = builtinFunctions();
  for (const [name, fn] of Object.entries(fns)) {
    assert.doesNotThrow(() => fn(undefined), `${name} 不应抛错`);
  }
  assert.equal(typeof fns.timestamp(), 'number');
  assert.equal(typeof fns.now(), 'string');
});
