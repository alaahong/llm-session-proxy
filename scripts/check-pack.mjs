#!/usr/bin/env node
// prepack 自检：发布前确认包结构完整，避免把半成品推上 npm。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'ROADMAP.md',
  'ROADMAP.zh-CN.md',
  'LICENSE',
  'bin/llm-session-proxy.js',
  'src/index.js',
  'src/config.js',
  'src/proxy.js',
  'src/session.js',
  'src/template.js',
  'src/inject.js',
  'src/logger.js',
  'src/messages.js',
  'src/cli.js',
  'examples/opencode-go.json',
  'examples/generic-openai.json',
  'examples/opencode-go-models.json',
];

for (const relative of REQUIRED_FILES) {
  if (!fs.existsSync(path.join(root, relative))) errors.push(`缺少必需文件: ${relative}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const field of ['name', 'version', 'description', 'license', 'repository', 'bin', 'exports', 'engines', 'keywords']) {
  if (!pkg[field]) errors.push(`package.json 缺少字段: ${field}`);
}
if (!/^\d+\.\d+\.\d+/.test(pkg.version || '')) errors.push(`version 不是合法语义化版本: ${pkg.version}`);
if (!/^[A-Za-z0-9.+-]+$/.test(pkg.license || '')) errors.push(`license 不是合法 SPDX 标识: ${pkg.license}`);
if (!Array.isArray(pkg.files) || pkg.files.length === 0) errors.push('files 白名单不能为空');

for (const [name, target] of Object.entries(pkg.bin || {})) {
  const binPath = path.join(root, target);
  if (!fs.existsSync(binPath)) {
    errors.push(`bin "${name}" 指向的文件不存在: ${target}`);
    continue;
  }
  if (!fs.readFileSync(binPath, 'utf8').startsWith('#!')) {
    errors.push(`bin "${name}" 缺少 shebang（#!），npx 会执行失败`);
  }
}

// 确认 files 白名单覆盖了 bin 与 src，否则发布出去的包会缺文件
const covered = (relative) =>
  (pkg.files || []).some((entry) => relative === entry || relative.startsWith(entry.replace(/\/$/, '') + '/'));
for (const relative of ['bin/llm-session-proxy.js', 'src/index.js', 'README.md', 'README.zh-CN.md', 'LICENSE']) {
  if (fs.existsSync(path.join(root, relative)) && !covered(relative)) {
    errors.push(`files 白名单没有覆盖: ${relative}`);
  }
}

if (errors.length) {
  process.stderr.write(`打包自检未通过:\n  - ${errors.join('\n  - ')}\n`);
  process.exit(1);
}

process.stdout.write(
  `打包自检通过: ${pkg.name}@${pkg.version}（${Object.keys(pkg.bin).length} 个可执行入口，` +
    `${pkg.files.length} 条 files 规则）\n`,
);
