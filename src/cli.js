import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG, buildConfig, parseUpstream } from './config.js';
import { NAME, VERSION } from './index.js';
import { Logger } from './logger.js';
import { MESSAGES, getLang, normalizeLang, setLang, t } from './messages.js';
import { createProxyServer } from './proxy.js';

/** 帮助文本用到的默认值快照。 */
const HELP_DEFAULTS = {
  port: DEFAULT_CONFIG.listen.port,
  host: DEFAULT_CONFIG.listen.host,
  timeoutMs: DEFAULT_CONFIG.request.timeoutMs,
  maxBodyBytes: DEFAULT_CONFIG.request.maxBodyBytes,
};

/** 生成帮助文本；默认语言为英文，`--lang zh` 时给中文。 */
export function helpText(lang = getLang()) {
  const previous = getLang();
  setLang(lang);
  const text = t('cli.help', { name: NAME, version: VERSION, defaults: HELP_DEFAULTS });
  setLang(previous);
  return text;
}

/** 向后兼容的英文帮助常量（历史导出名）。 */
export const HELP = helpText('en');

/** 示例配置模板；默认语言为英文，`--init --lang zh` 时给中文。 */
export function sampleConfig(lang = getLang()) {
  return MESSAGES[normalizeLang(lang) || 'en']?.['cli.sampleConfig']() ?? MESSAGES.en['cli.sampleConfig']();
}

/** 向后兼容的英文示例配置常量（历史导出名）。 */
export const SAMPLE_CONFIG = sampleConfig('en');

const VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-p',
  '--port',
  '--host',
  '-u',
  '--upstream',
  '--base-path',
  '--path-rewrite',
  '--inject',
  '--body-inject',
  '--model-prefix',
  '--model-map',
  '--session-header',
  '--session-field',
  '--session-id-format',
  '--request-id-format',
  '--timeout',
  '--max-body',
  '-l',
  '--lang',
  '--log-level',
  '--log-file',
]);

/**
 * 预扫描命令行里的 --lang / -l（以及 PROXY_LANG 环境变量）。
 *
 * 存在的理由：parseArgv 自身可能抛错（比如拼错的参数名），而那时还没走到
 * 「合并配置」那一步。先扫一遍拿到语言，报错才会用用户想要的语言。
 */
function scanLang(argv, env = {}) {
  let found = null;
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '-l' || raw === '--lang') {
      if (argv[i + 1] !== undefined) found = argv[i + 1];
    } else if (raw.startsWith('--lang=') || raw.startsWith('-l=')) {
      found = raw.slice(raw.indexOf('=') + 1);
    }
  }
  if (found === null) found = env.PROXY_LANG ?? null;
  return normalizeLang(found);
}

function setByPath(target, keyPath, value) {
  let cursor = target;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keyPath[keyPath.length - 1]] = value;
}

function splitOnce(text, separator) {
  const index = text.indexOf(separator);
  if (index === -1) return [text, undefined];
  return [text.slice(0, index), text.slice(index + separator.length)];
}

/**
 * 解析命令行参数，返回用户显式给出的配置片段。
 * 纯函数，不触碰进程状态，便于单元测试。
 */
export function parseArgv(argv) {
  // argv 里明确写了 --lang 时，连本函数自己的报错也用该语言
  const detected = scanLang(argv);
  if (detected) setLang(detected);

  const flags = {};
  const push = (keyPath, value) => {
    const current = keyPath.reduce((acc, key) => acc?.[key], flags);
    if (Array.isArray(current)) current.push(value);
    else setByPath(flags, keyPath, [value]);
  };

  let configFile = null;
  let printConfig = false;
  let initFile = null;
  let initRequested = false;

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('-')) {
      throw new Error(t('cli.err.unknownArg', { raw }));
    }
    const [flag, inlineValue] = splitOnce(raw, '=');
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new Error(t('cli.err.missingValue', { flag }));
      i += 1;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        return { help: true };
      case '-v':
      case '--version':
        return { version: true };
      case '-c':
      case '--config':
        configFile = takeValue();
        break;
      case '--print-config':
        printConfig = true;
        break;
      case '--init': {
        initRequested = true;
        if (inlineValue !== undefined) {
          initFile = inlineValue;
        } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          i += 1;
          initFile = argv[i];
        }
        break;
      }
      case '-p':
      case '--port':
        setByPath(flags, ['listen', 'port'], Number(takeValue()));
        break;
      case '--host':
        setByPath(flags, ['listen', 'host'], takeValue());
        break;
      case '-u':
      case '--upstream':
        setByPath(flags, ['upstream'], parseUpstream(takeValue()));
        break;
      case '--base-path':
        setByPath(flags, ['upstream', 'basePath'], takeValue());
        break;
      case '-l':
      case '--lang': {
        const value = takeValue();
        // 归一化已知写法（zh-CN → zh）；识别不了的先原样留下，由配置校验统一报错
        setByPath(flags, ['lang'], normalizeLang(value) || value);
        break;
      }
      case '--path-rewrite': {
        const [pattern, replacement] = splitOnce(takeValue(), '=>');
        if (replacement === undefined) throw new Error(t('cli.err.pathRewriteFormat'));
        push(['request', 'pathRewrite'], { pattern, replacement });
        break;
      }
      case '--inject': {
        const [name, value] = splitOnce(takeValue(), '=');
        if (value === undefined) throw new Error(t('cli.err.injectFormat'));
        setByPath(flags, ['inject', 'headers', name], value);
        break;
      }
      case '--body-inject': {
        const [key, value] = splitOnce(takeValue(), '=');
        if (value === undefined) throw new Error(t('cli.err.bodyInjectFormat'));
        setByPath(flags, ['inject', 'body', key], value);
        break;
      }
      case '--model-prefix':
        push(['model', 'stripPrefixes'], takeValue());
        break;
      case '--model-map': {
        const [alias, real] = splitOnce(takeValue(), '=');
        if (real === undefined) throw new Error(t('cli.err.modelMapFormat'));
        setByPath(flags, ['model', 'map', alias], real);
        break;
      }
      case '--session-header':
        push(['session', 'headerNames'], takeValue().toLowerCase());
        break;
      case '--session-field':
        push(['session', 'bodyFields'], takeValue());
        break;
      case '--session-id-format':
        setByPath(flags, ['session', 'idFormat'], takeValue());
        break;
      case '--request-id-format':
        setByPath(flags, ['session', 'requestIdFormat'], takeValue());
        break;
      case '--no-session':
        setByPath(flags, ['session', 'enabled'], false);
        break;
      case '--no-stream':
        setByPath(flags, ['response', 'stream'], false);
        break;
      case '--timeout':
        setByPath(flags, ['request', 'timeoutMs'], Number(takeValue()));
        break;
      case '--max-body':
        setByPath(flags, ['request', 'maxBodyBytes'], Number(takeValue()));
        break;
      case '--log-level':
        setByPath(flags, ['log', 'level'], takeValue());
        break;
      case '--log-file':
        setByPath(flags, ['log', 'file'], takeValue());
        break;
      default:
        if (VALUE_FLAGS.has(flag)) throw new Error(t('cli.err.notImplemented', { flag }));
        throw new Error(t('cli.err.unknownFlag', { flag }));
    }
  }

  return { flags, configFile, printConfig, initRequested, initFile };
}


export function printBanner(logger, config, proxy, url) {
  const injected = Object.keys(config.inject.headers || {});
  logger.info(t('cli.banner.started', { name: NAME, version: VERSION }));
  logger.info(t('cli.banner.listen', { url }));
  logger.info(t('cli.banner.upstream', { url: `${proxy.upstream.protocol}://${proxy.upstream.hostHeader}${proxy.upstream.basePath}` }));
  logger.info(t('cli.banner.injectHeaders', { list: injected.length ? injected.join(', ') : t('cli.banner.none') }));
  logger.info(
    t('cli.banner.modelAliases', {
      prefix: config.model.stripPrefixes.length
        ? t('cli.banner.stripPrefixes', { list: config.model.stripPrefixes.join(', ') })
        : t('cli.banner.stripDisabled'),
      map: Object.keys(config.model.map || {}).length
        ? t('cli.banner.mapSuffix', { json: JSON.stringify(config.model.map) })
        : '',
    }),
  );
  logger.info(
    t('cli.banner.session', {
      value: config.session.enabled
        ? t('cli.banner.sessionValue', {
            format: config.session.idFormat,
            requestIdFormat: config.session.requestIdFormat,
          })
        : t('cli.banner.sessionOff'),
    }),
  );
  logger.info(
    t('cli.banner.pathRewrite', {
      value: config.request.pathRewrite.length
        ? config.request.pathRewrite.map((rule) => `${rule.pattern} => ${rule.replacement}`).join(' | ')
        : t('cli.banner.pathRewritePassthrough'),
    }),
  );
  logger.info(t('cli.banner.baseUrlHeading'));
  if (config.upstream.basePath) {
    logger.info(t('cli.banner.baseUrlPrefixed', { url, basePath: config.upstream.basePath }));
    logger.info(t('cli.banner.baseUrlOtherPath', { url }));
  } else if (config.request.pathRewrite.length) {
    logger.info(t('cli.banner.baseUrlRewritten', { url }));
  } else {
    logger.info(t('cli.banner.baseUrlRaw', { url }));
  }
  logger.info(t('cli.banner.statusEndpoint', { url }));
  if (config.__configPath) logger.info(t('cli.banner.configFile', { path: config.__configPath }));
  if (config.log.file) logger.info(t('cli.banner.logFile', { path: path.resolve(config.log.file) }));
}

/**
 * 安装进程级兜底。
 *
 * 默认行为下，一个未捕获异常或未处理的 Promise 拒绝会直接终止进程，
 * 而栈信息只打到 stderr —— 日志文件里一个字都不会有，
 * 表现出来就是「日志一切正常，进程却凭空消失」，极难排查。
 * 这里改成：写进日志文件 + stderr，然后**继续运行**。
 * 只有短时间内反复出错（判定为持续故障，再跑下去也没意义）才主动退出。
 */
export function installProcessGuards(logger) {
  const recent = [];
  const WINDOW_MS = 60_000;
  const LIMIT = 20;

  const record = (kind, error) => {
    const now = Date.now();
    while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
    recent.push(now);

    const detail = error?.stack || error?.message || String(error);
    logger.error(t('cli.guard.uncaught', { kind, detail }));
    try {
      // logger 的文件写入可能因磁盘/权限静默降级，stderr 是最后一道线索
      process.stderr.write(`${kind}: ${detail}\n`);
    } catch {
      /* 连 stderr 都写不进去就只能放弃 */
    }

    if (recent.length > LIMIT) {
      logger.error(t('cli.guard.tooMany', { kind, seconds: WINDOW_MS / 1000, count: recent.length }));
      process.exit(1);
    }
  };

  process.on('uncaughtException', (error) => record('uncaughtException', error));
  process.on('unhandledRejection', (reason) =>
    record('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))),
  );
}

/**
 * CLI 主入口。返回时服务器已在后台运行（进程不会退出）。
 * 错误通过 process.exitCode 表达，避免在测试中强杀进程。
 */
export async function runCli(argv = process.argv.slice(2)) {
  // 先按命令行/环境变量定下语言，这样连 parseArgv 的报错也是用户想要的语言
  const detected = scanLang(argv, process.env);
  if (detected) setLang(detected);

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${helpText().trim()}\n`);
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.initRequested) {
    const target = path.resolve(parsed.initFile || `${NAME}.config.json`);
    if (fs.existsSync(target)) {
      process.stderr.write(`${t('cli.init.exists', { target })}\n`);
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(target, sampleConfig(), 'utf8');
    process.stdout.write(t('cli.init.created', { target, name: NAME }));
    return;
  }

  let config;
  try {
    // buildConfig 内部会按合并后的 lang 再调一次 setLang，配置文件里的语言同样生效
    config = buildConfig({ file: parsed.configFile, flags: parsed.flags });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.printConfig) {
    const printable = { ...config };
    delete printable.__configPath;
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
    return;
  }

  const logger = new Logger({ ...config.log, console: config.log.level !== 'silent' });
  installProcessGuards(logger);
  const proxy = createProxyServer({ config, logger });

  let address;
  try {
    address = await proxy.listen();
  } catch (error) {
    logger.error(t('cli.startFailed', { message: error.message }));
    if (error.code === 'EADDRINUSE') {
      logger.error(
        t('cli.portInUse', { port: config.listen.port, name: NAME, nextPort: config.listen.port + 1 }),
      );
    }
    process.exitCode = 1;
    return;
  }

  const host = config.listen.host === '0.0.0.0' ? '127.0.0.1' : config.listen.host;
  printBanner(logger, config, proxy, `http://${host}:${address.port}`);

  const shutdown = async (signal) => {
    logger.info(t('cli.shutdown.signal', { signal }));
    await proxy.close();
    logger.info(t('cli.shutdown.done'));
    logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
