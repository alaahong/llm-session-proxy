#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG, buildConfig, parseUpstream } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { createProxyServer } from '../src/proxy.js';
import { NAME, VERSION } from '../src/index.js';

const HELP = `
${NAME} v${VERSION}
可自定义参数的 LLM 本地反向代理：自动生成/透传会话 ID、注入任意请求头、重写模型别名与请求路径。

用法
  ${NAME} [选项]

常用选项
  -c, --config <file>          读取 JSON 配置文件（支持 // 与 /* */ 注释、尾随逗号）
  -p, --port <number>          监听端口（默认 ${DEFAULT_CONFIG.listen.port}）
      --host <addr>            监听地址（默认 ${DEFAULT_CONFIG.listen.host}）
  -u, --upstream <url>         上游地址，如 https://opencode.ai 或 host:port
      --base-path <path>       转发路径统一前缀，如 /zen/go/v1
      --path-rewrite <a=>b>    路径重写（正则 => 替换），可重复
      --inject <name=value>    追加/覆盖注入的请求头，可重复。值支持模板，如 {{session.id}}
      --body-inject <k=v>      往请求体注入字段（支持点路径与模板），可重复
      --model-prefix <prefix>  需要剥离的模型名前缀，可重复（默认 proxy-）
      --model-map <a=b>        模型名精确映射，可重复（优先于前缀剥离）
      --session-header <name>  追加"从哪个请求头读客户端会话"，可重复
      --session-field <path>   追加"从哪个请求体字段读客户端会话"，可重复
      --session-id-format <f>  会话 ID 格式：hex26 | hex | uuid | base36 | short
      --request-id-format <t>  请求号模板，如 "msg_{{session.count}}"
      --no-session             完全关闭会话 ID 注入
      --no-stream              关闭流式透传（整体缓冲后返回）
      --timeout <ms>           上游请求超时（默认 ${DEFAULT_CONFIG.request.timeoutMs}）
      --max-body <bytes>       请求体上限（默认 ${DEFAULT_CONFIG.request.maxBodyBytes}）
      --log-level <level>      日志级别：silent | error | warn | info | debug
      --log-file <file>        额外写入日志文件（自动按大小轮转）

本地工具
      --print-config           打印合并后的最终配置并退出
      --init [file]            生成一份带注释的示例配置（默认 ./${NAME}.config.json）
  -h, --help                   显示帮助
  -v, --version                显示版本

示例
  # OpenCode Go：客户端 Base URL 填 http://127.0.0.1:9355/zen/go/v1
  ${NAME}

  # 把客户端的 /v1/... 映射到上游的 /zen/go/v1/...
  ${NAME} -u https://opencode.ai --path-rewrite "^/v1/=>/zen/go/v1/"

  # 任意自建上游：换地址 + 换注入头
  ${NAME} -u https://api.example.com --inject "x-api-version=2026-01-01" \\
          --inject "x-session-id={{session.id}}" --model-prefix ""

  # 生成配置文件后按需修改
  ${NAME} --init
`;

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
  '--log-level',
  '--log-file',
]);

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

function parseArgv(argv) {
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
      throw new Error(`无法识别的参数: ${raw}`);
    }
    const [flag, inlineValue] = splitOnce(raw, '=');
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new Error(`参数 ${flag} 缺少取值`);
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
      case '--init':
        initRequested = true;
        initFile = inlineValue ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? (i += 1, argv[i]) : null);
        break;
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
      case '--path-rewrite': {
        const [pattern, replacement] = splitOnce(takeValue(), '=>');
        if (replacement === undefined) throw new Error('--path-rewrite 需要 "正则=>替换" 形式');
        push(['request', 'pathRewrite'], { pattern, replacement });
        break;
      }
      case '--inject': {
        const [name, value] = splitOnce(takeValue(), '=');
        if (value === undefined) throw new Error('--inject 需要 name=value 形式');
        setByPath(flags, ['inject', 'headers', name], value);
        break;
      }
      case '--body-inject': {
        const [key, value] = splitOnce(takeValue(), '=');
        if (value === undefined) throw new Error('--body-inject 需要 key=value 形式');
        setByPath(flags, ['inject', 'body', key], value);
        break;
      }
      case '--model-prefix':
        push(['model', 'stripPrefixes'], takeValue());
        break;
      case '--model-map': {
        const [alias, real] = splitOnce(takeValue(), '=');
        if (real === undefined) throw new Error('--model-map 需要 alias=real 形式');
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
        if (VALUE_FLAGS.has(flag)) throw new Error(`参数 ${flag} 尚未实现`);
        throw new Error(`无法识别的参数: ${flag}（用 --help 查看用法）`);
    }
  }

  return { flags, configFile, printConfig, initRequested, initFile };
}

const SAMPLE_CONFIG = `{
  // 说明：本文件支持 // 与 /* */ 注释以及尾随逗号。
  // 所有字段都可以省略，省略即采用默认值。

  "listen": { "host": "127.0.0.1", "port": 9355 },

  // 上游。host 也可以直接写完整 URL，例如 "https://opencode.ai"
  "upstream": {
    "protocol": "https",
    "host": "opencode.ai",
    "port": null,
    "basePath": ""            // 转发时统一加的前缀，如 "/zen/go/v1"
  },

  "request": {
    "bufferBody": true,        // 需要改写请求体时必须为 true
    "maxBodyBytes": 67108864,
    "timeoutMs": 600000,
    // 把客户端请求的 /v1/... 映射到上游的 /zen/go/v1/...
    "pathRewrite": [
      // { "pattern": "^/v1/", "replacement": "/zen/go/v1/" }
    ],
    "dropHeaders": [],
    "forwardClientSessionHeaders": true
  },

  "session": {
    "enabled": true,
    // 从哪里读取客户端自带的会话标识（优先级从高到低）
    "headerNames": ["x-opencode-session", "x-session-id", "x-conversation-id", "x-thread-id"],
    "bodyFields": ["session_id", "sessionId", "conversation_id", "conversationId"],
    // 客户端没带会话标识时，用 system + 首条 user 消息的内容指纹兜底
    "contentHash": {
      "enabled": true,
      "fields": ["system", "system_instruction", "instructions"],
      "includeFirstUserMessage": true
    },
    "idPrefix": "ses_",
    "idFormat": "hex26",                     // hex26 | hex | uuid | base36 | short
    "requestIdFormat": "msg_{{session.count}}",
    "maxSessions": 512,
    "ttlSeconds": 0                          // 0 表示不过期
  },

  "inject": {
    // 值支持模板：{{session.id}} {{session.requestId}} {{session.count}}
    //             {{uuid}} {{random}} {{randomHex:16}} {{timestamp}} {{env.HOME}}
    "headers": {
      "x-opencode-session": "{{session.id}}",
      "x-opencode-request": "{{session.requestId}}",
      "x-opencode-client": "cli",
      "x-opencode-project": "global"
    },
    "body": {},                  // 追加到请求体的字段，如 { "temperature": 0.2 }
    "removeBodyFields": [],
    "overwrite": true            // false 表示不覆盖客户端已有的同名头
  },

  "model": {
    "enabled": true,
    "field": "model",
    "stripPrefixes": ["proxy-"],  // 客户端为避开内置通道而加的前缀，这里剥掉
    "map": {},                    // 精确映射，优先于前缀剥离：{ "my-glm": "glm-5.3-flash" }
    "default": null
  },

  "userAgent": "opencode/1.18.29 cli",
  "userAgentMode": "replace-generic",  // keep | replace | replace-generic

  "response": { "stream": true, "timeoutMs": 600000 },

  "log": { "level": "info", "file": null, "maxBytes": 5242880, "backups": 2 }
}
`;

function printBanner(logger, config, proxy, url) {
  const injected = Object.keys(config.inject.headers || {});
  logger.info(`${NAME} v${VERSION} 已启动`);
  logger.info(`  监听地址    ${url}`);
  logger.info(`  上游        ${proxy.upstream.protocol}://${proxy.upstream.hostHeader}${proxy.upstream.basePath}`);
  logger.info(
    `  注入请求头  ${injected.length ? injected.join(', ') : '(无)'}`,
  );
  logger.info(
    `  模型别名    ${config.model.stripPrefixes.length ? `剥离前缀 ${config.model.stripPrefixes.join(', ')}` : '未启用前缀剥离'}` +
      `${Object.keys(config.model.map || {}).length ? ` | 映射 ${JSON.stringify(config.model.map)}` : ''}`,
  );
  logger.info(`  会话 ID     ${config.session.enabled ? `${config.session.idFormat}，请求号 ${config.session.requestIdFormat}` : '已关闭'}`);
  logger.info(`  路径重写    ${config.request.pathRewrite.length ? config.request.pathRewrite.map((r) => `${r.pattern} => ${r.replacement}`).join(' | ') : '(无，原样透传)'}`);
  logger.info('  ── 客户端 Base URL 怎么填 ──');
  if (config.upstream.basePath) {
    logger.info(`      ${url}     （自动补上 ${config.upstream.basePath}）`);
    logger.info(`      其他路径   ${url}/原路径`);
  } else if (config.request.pathRewrite.length) {
    logger.info(`      ${url}/v1   （按上面的重写规则转到上游）`);
  } else {
    logger.info(`      ${url}/zen/go/v1   或按上游路径原样拼接`);
  }
  logger.info(`  状态端点    ${url}/__llm_session_proxy__/status`);
  if (config.__configPath) logger.info(`  配置文件    ${config.__configPath}`);
  if (config.log.file) logger.info(`  日志文件    ${path.resolve(config.log.file)}`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  if (parsed.help) {
    process.stdout.write(`${HELP.trim()}\n`);
    return;
  }
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.initRequested) {
    const target = path.resolve(parsed.initFile || `${NAME}.config.json`);
    if (fs.existsSync(target)) {
      process.stderr.write(`文件已存在，未覆盖: ${target}\n`);
      process.exit(1);
    }
    fs.writeFileSync(target, SAMPLE_CONFIG, 'utf8');
    process.stdout.write(`已生成示例配置: ${target}\n按需修改后用 ${NAME} --config "${target}" 启动。\n`);
    return;
  }

  let config;
  try {
    config = buildConfig({ file: parsed.configFile, flags: parsed.flags });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  if (parsed.printConfig) {
    const printable = { ...config };
    delete printable.__configPath;
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
    return;
  }

  const logger = new Logger({ ...config.log, console: config.log.level !== 'silent' });
  const proxy = createProxyServer({ config, logger });

  let address;
  try {
    address = await proxy.listen();
  } catch (error) {
    logger.error(`启动失败: ${error.message}`);
    if (error.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.listen.port} 已被占用，换一个：${NAME} --port ${config.listen.port + 1}`);
    }
    process.exit(1);
  }

  const host = config.listen.host === '0.0.0.0' ? '127.0.0.1' : config.listen.host;
  printBanner(logger, config, proxy, `http://${host}:${address.port}`);

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭…`);
    await proxy.close();
    logger.info('已停止');
    logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  process.stderr.write(`未捕获异常: ${error?.stack || error}\n`);
  process.exit(1);
});
