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
import { convertRequestBody, describeConverters, isConverter, listConverters } from './converters.js';
import { diagnose, explainModel, pickSampleModel, renderDiagnosis, runDoctor } from './doctor.js';
import { applyBodyInject, buildInjectHeaders, rewriteModel, rewritePath } from './inject.js';
import { Logger, logDetail } from './logger.js';
import { getLang, normalizeLang, setLang, t as translate } from './messages.js';
import { DEFAULT_MODEL_MAP } from './models.js';
import { FORBIDDEN_PORTS, isForbiddenPort, listenUntilUsablePort } from './ports.js';
import { convertResponseJson, listResponseConverters } from './replies.js';
import { PROTOCOLS, detectProtocol, resolveProtocolRoute, upstreamPathFor } from './protocol.js';
import { createProxyServer } from './proxy.js';
import {
  BUILTIN_BUCKETS,
  applyBucketModel,
  composeTransformers,
  describeBuckets,
  describeRule,
  getBucket,
  hasMatcher,
  matchRule,
  resolveRoute,
} from './router.js';
import {
  SessionStore,
  contentFingerprint,
  findExplicitSession,
  generateId,
  normalizeSessionId,
  resolveSession,
} from './session.js';
import {
  BUILTIN_SCORERS,
  bandFor,
  describeScorers,
  isScorer,
  listScorers,
  normalizeBands,
  resolveDifficulty,
  scoreRequest,
} from './scoring.js';
import { createContext, randomBase36, randomHex, renderDeep, renderTemplate } from './template.js';
import { applyTransformers, describeTransformers, listTransformers } from './transformers.js';
import { createSseParser, createStreamTranscoder } from './stream.js';
import {
  PROVIDER_TYPES,
  credentialSources,
  describeProvider,
  describeUpstreams,
  normalizeProvider,
  normalizeUpstreams,
  resolveUpstream as resolvePoolUpstream,
  resolveWire,
  upstreamPathFor as providerPathFor,
} from './upstreams.js';
import {
  COPILOT_TOKEN_ENV,
  COPILOT_TOKEN_MODES,
  DEFAULT_COPILOT_TOKEN_MODE,
  classifyToken,
  createCopilotSessionManager,
  normalizeCopilotTokenMode,
  requestDeviceCode,
  pollDeviceToken,
  resolveGitHubToken,
  runDeviceFlow,
} from './copilot.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(moduleDir, '..', 'package.json'), 'utf8'));

export const VERSION = pkg.version;
export const NAME = pkg.name;

export {
  BUILTIN_BUCKETS,
  BUILTIN_SCORERS,
  COPILOT_TOKEN_ENV,
  COPILOT_TOKEN_MODES,
  DEFAULT_CONFIG,
  DEFAULT_COPILOT_TOKEN_MODE,
  DEFAULT_MODEL_MAP,
  FORBIDDEN_PORTS,
  Logger,
  PROVIDER_TYPES,
  SessionStore,
  applyBodyInject,
  applyBucketModel,
  applyTransformers,
  bandFor,
  buildConfig,
  buildInjectHeaders,
  classifyToken,
  composeTransformers,
  contentFingerprint,
  convertRequestBody,
  convertResponseJson,
  createCopilotSessionManager,
  createProxyServer,
  createSseParser,
  createStreamTranscoder,
  createContext,
  credentialSources,
  deepMerge,
  defaultLogDir,
  describeBuckets,
  describeConverters,
  describeProvider,
  describeRule,
  describeScorers,
  describeTransformers,
  describeUpstreams,
  detectProtocol,
  diagnose,
  explainModel,
  findExplicitSession,
  generateId,
  getBucket,
  getLang,
  hasMatcher,
  isConverter,
  isForbiddenPort,
  isScorer,
  listConverters,
  listResponseConverters,
  listScorers,
  listTransformers,
  listenUntilUsablePort,
  loadConfigFile,
  logDetail,
  matchRule,
  normalizeBands,
  normalizeCopilotTokenMode,
  normalizeLang,
  normalizeProvider,
  normalizeSessionId,
  normalizeUpstreams,
  parseJsonLoose,
  parseUpstream,
  pickSampleModel,
  pollDeviceToken,
  PROTOCOLS,
  providerPathFor,
  randomBase36,
  randomHex,
  renderDeep,
  renderDiagnosis,
  renderTemplate,
  requestDeviceCode,
  resolveDifficulty,
  resolveGitHubToken,
  resolveLogFile,
  resolvePoolUpstream,
  resolveProtocolRoute,
  resolveRoute,
  resolveSession,
  resolveUpstream,
  resolveWire,
  rewriteModel,
  rewritePath,
  runDeviceFlow,
  runDoctor,
  scoreRequest,
  setLang,
  translate,
  upstreamPathFor,
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
    ? deepMerge(structuredClone(DEFAULT_CONFIG), providedConfig)
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
