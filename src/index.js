import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  buildConfig,
  deepMerge,
  defaultLogDir,
  loadConfigFile,
  parseJsonLoose,
  parseUpstream,
  resolveLogFile,
  resolveUpstream,
} from './config.js';
import { applyBodyInject, buildInjectHeaders, rewriteModel, rewritePath } from './inject.js';
import { Logger } from './logger.js';
import { getLang, normalizeLang, setLang, t as translate } from './messages.js';
import { createProxyServer } from './proxy.js';
import {
  SessionStore,
  contentFingerprint,
  findExplicitSession,
  generateId,
  normalizeSessionId,
  resolveSession,
} from './session.js';
import { createContext, randomBase36, randomHex, renderDeep, renderTemplate } from './template.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(moduleDir, '..', 'package.json'), 'utf8'));

export const VERSION = pkg.version;
export const NAME = pkg.name;

export {
  DEFAULT_CONFIG,
  Logger,
  SessionStore,
  applyBodyInject,
  buildConfig,
  buildInjectHeaders,
  contentFingerprint,
  createContext,
  createProxyServer,
  deepMerge,
  defaultLogDir,
  findExplicitSession,
  generateId,
  getLang,
  loadConfigFile,
  normalizeLang,
  normalizeSessionId,
  parseJsonLoose,
  parseUpstream,
  randomBase36,
  randomHex,
  renderDeep,
  renderTemplate,
  resolveLogFile,
  resolveSession,
  resolveUpstream,
  rewriteModel,
  rewritePath,
  setLang,
  translate,
};

/**
 * 一步启动代理（适合在脚本里内嵌使用）。
 *
 * const proxy = await startProxy({ configFile: './my.json' });
 * console.log(proxy.url);
 */
export async function startProxy(options = {}) {
  const {
    config: providedConfig,
    configFile = null,
    env = process.env,
    flags = {},
    logger: providedLogger = null,
    silent = false,
  } = options;

  const config = providedConfig
    ? deepMerge(DEFAULT_CONFIG, providedConfig)
    : buildConfig({ file: configFile, env, flags });

  // 让内嵌使用时的日志/报错语言也跟随配置（默认英文）
  if (typeof config.lang === 'string') setLang(config.lang);

  const logger =
    providedLogger ||
    new Logger({
      ...config.log,
      file: resolveLogFile(config.log, { name: NAME, env }),
      console: !silent && config.log.level !== 'silent',
    });
  const proxy = createProxyServer({ config, logger });
  await proxy.listen();

  const address = proxy.server.address();
  const host = config.listen.host === '0.0.0.0' ? '127.0.0.1' : config.listen.host;
  const url = `http://${host}:${address.port}`;

  return {
    ...proxy,
    url,
    logger,
    async stop() {
      await proxy.close();
      logger.close();
    },
  };
}

export default {
  NAME,
  VERSION,
  startProxy,
  createProxyServer,
  buildConfig,
  SessionStore,
  Logger,
};
