/**
 * 运行时输出的文案表（i18n）。
 *
 * 设计取舍：
 * - **默认英文**。命令行帮助、启动横幅、日志、回给客户端的错误消息一律先出英文，
 *   需要中文时显式指定 `--lang zh`（或 `PROXY_LANG=zh` / 配置文件里的 `"lang": "zh"`）。
 * - **日志前缀不翻译**。`[req]` / `[res]` / `[request-failed]` 这类标签在两种语言下完全一致，
 *   这样 `grep '\[res\]'` 之类的排查手法不会因为语言切换而失效。
 * - 用**全局当前语言**而不是层层传参：这是单进程 CLI 工具，全局变量换来的是
 *   调用点统一写成 `t('key', { ... })`，不需要把 translator 透传进每个模块。
 *   作为库内嵌使用时，默认英文；想换语言显式调 `setLang()` 或在配置里给 `lang`。
 * - 缺 key 时 `t()` 原样返回 key 本身（不抛错），配合「两套文案 key 集合必须一致」的测试，
 *   漏翻译会在测试里暴露，而不是在用户面前变成 `undefined`。
 */

/** 支持的语言。第一个是默认值。 */
export const SUPPORTED_LANGS = ['en', 'zh'];
export const DEFAULT_LANG = 'en';

/** 把各种写法归一化：zh / zh-CN / zh-Hans / cn / 中文 → 'zh'；en / en-US / english → 'en'。 */
export function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase().replace(/_/g, '-');
  if (!tag) return null;
  if (tag === 'zh' || tag.startsWith('zh-') || tag === 'cn' || tag === 'chinese' || value.trim() === '中文') {
    return 'zh';
  }
  if (tag === 'en' || tag.startsWith('en-') || tag === 'english') return 'en';
  return null;
}

const en = {
  // ---------- config.js：配置解析与校验 ----------
  'config.parseFailed': ({ source, message }) => `Failed to parse the config file (${source}): ${message}`,
  'config.rootNotObject': ({ path }) => `The config file root must be an object (${path})`,
  'config.envNotNumber': ({ key, raw }) => `Environment variable ${key} must be a number, got "${raw}"`,
  'config.badRegex': ({ pattern, message }) => `Invalid regular expression in pathRewrite "${pattern}": ${message}`,
  'config.badPort': ({ port }) => `Invalid listen.port: ${port}`,
  'config.emptyHost': () => 'upstream.host cannot be empty',
  'config.badProtocol': ({ protocol }) => `upstream.protocol only supports http / https, got ${protocol}`,
  'config.badIdFormat': ({ format }) => `Unsupported session.idFormat: ${format}`,
  'config.injectNotObject': () => 'inject.headers must be an object (values are template strings)',
  'config.badLang': ({ lang }) => `Unsupported lang: ${lang} (expected: ${SUPPORTED_LANGS.join(' | ')})`,
  'config.validationFailed': ({ list }) => `Config validation failed:\n  - ${list}`,
  'config.badLog': () => 'log must be an object',
  'config.badLogFile': ({ file }) =>
    `log.file must be a path string or false (console only), got ${file}`,
  'config.badLogDir': ({ dir }) => `log.dir must be a path string or null, got ${dir}`,
  'config.badLogRotate': ({ rotate, modes }) => `log.rotate must be ${modes}, got ${rotate}`,
  'config.badLogLevel': ({ level, levels }) => `log.level must be ${levels}, got ${level}`,
  'config.badLogNumber': ({ key, value }) => `${key} must be a non-negative number, got ${value}`,
  'config.badModel': () => 'model must be an object',
  'config.badModelMap': ({ value }) => `model.map must be an object of { alias: realModelId }, got ${value}`,
  'config.badModelMapEntry': ({ alias, value }) =>
    `model.map["${alias}"] must be a non-empty model id string, got ${value}`,
  'config.badModelField': ({ field }) => `model.field must be a non-empty string, got ${field}`,
  'config.badRouter': () => 'router must be an object',
  'config.badRouterBuckets': () => 'router.buckets must declare at least one bucket',
  'config.badRouterDefaultBucket': ({ bucket, buckets }) =>
    `router.defaultBucket ${bucket} is not declared in router.buckets (available: ${buckets})`,
  'config.badRouterForced': ({ bucket, buckets }) =>
    `--router "${bucket}" is not a declared bucket (available: ${buckets})`,
  'config.badRouterRuleBucket': ({ index, bucket, buckets }) =>
    `router.rules[${index}] points at bucket "${bucket}", which is not declared (available: ${buckets})`,
  'config.badRouterRuleNoMatch': ({ index, bucket }) =>
    `router.rules[${index}] (bucket "${bucket}") has no matcher — add one of path / modelPrefix / bodyField / minBytes / maxBytes, or the rule can never apply`,
  'config.badRouterRuleBytes': ({ index, key, value }) =>
    `router.rules[${index}].${key} must be a non-negative number, got ${value}`,
  'config.badTransformerName': ({ where, name, known }) =>
    `${where}: "${name}" is not a registered transformer (available: ${known})`,
  'config.badTransformerOptions': () => 'transformers.options must be an object keyed by transformer name',
  'config.badTransformers': () => 'transformers must be an object with "enabled" and "options"',
  'config.badTransformerEnabled': () => 'transformers.enabled must be an array of transformer names',

  // ---------- cli.js：帮助与示例配置 ----------
  'cli.help': ({ name, version, defaults }) => `
${name} v${version}
A configurable local reverse proxy for LLM APIs: generates or forwards session IDs,
injects arbitrary request headers, and rewrites model aliases and request paths.

USAGE
  ${name} [options]

OPTIONS
  -c, --config <file>          Read a JSON config file (// and /* */ comments and trailing commas allowed)
  -p, --port <number>          Listen port (default ${defaults.port})
      --host <addr>            Listen address (default ${defaults.host})
  -u, --upstream <url>         Upstream, e.g. https://opencode.ai or host:port
      --base-path <path>       Prefix prepended to every forwarded path, e.g. /zen/go/v1
      --path-rewrite <a=>b>    Path rewrite (regex => replacement), repeatable
      --inject <name=value>    Add or override a request header, repeatable. Values support templates such as {{session.id}}
      --body-inject <k=v>      Inject a request body field (dot paths and templates supported), repeatable
      --model-prefix <prefix>  Model name prefix to strip, repeatable (default proxy-)
      --model-map <a=b>        Exact model name mapping, repeatable (takes precedence over prefix
                               stripping; merged over the built-in OpenCode alias table)
      --transformer <name>     Attach a named body transform, repeatable (replaces the whole list;
                               the name alone enables it). Available: noop | drop-fields |
                               drop-empty-fields | rename-fields | clamp-max-tokens
      --router <bucket>        Force every request through one bucket, ignoring the rules
      --no-router              Disable router buckets
      --session-header <name>  Add a request header to read the client session from, repeatable
      --session-field <path>   Add a request body field to read the client session from, repeatable
      --session-id-format <f>  Session ID format: hex26 | hex | uuid | base36 | short
      --request-id-format <t>  Request ID template, e.g. "msg_{{session.count}}"
      --no-session             Disable session ID injection entirely
      --no-stream              Disable streaming pass-through (buffer the whole response)
      --timeout <ms>           Upstream request timeout (default ${defaults.timeoutMs})
      --max-body <bytes>       Maximum request body size (default ${defaults.maxBodyBytes})
  -l, --lang <en|zh>           Language of console output and log messages (default en)
      --log-level <level>      Log level: silent | error | warn | info | debug
      --log-file <file>        Log file (default ~/.lsp/logs/${name}.log)
      --no-log-file            Do not write a log file (console only)
      --log-dir <dir>          Directory of the default log file
      --log-rotate <mode>      size | daily | off (default size)
      --log-keep-days <days>   Delete rotated logs older than this (default 30, 0 = keep forever)

LOCAL TOOLS
      --print-config           Print the merged config and exit
      --dry-run                Check the config and show how a request would be routed, without any network I/O
      --doctor                 Like --dry-run, plus upstream reachability and listen-port checks; exits non-zero on problems
      --model <id>             Sample model name used by --dry-run / --doctor (default: derived from the model map)
      --init [file]            Write an annotated sample config (default ./${name}.config.json)
  -h, --help                   Show this help
  -v, --version                Show the version

EXAMPLES
  # OpenCode Go: point the client Base URL at http://127.0.0.1:9355/zen/go/v1
  ${name}

  # Map the client's /v1/... onto the upstream's /zen/go/v1/...
  ${name} -u https://opencode.ai --path-rewrite "^/v1/=>/zen/go/v1/"

  # Any custom upstream: swap the address and the injected headers
  ${name} -u https://api.example.com --inject "x-api-version=2026-01-01" \\
          --inject "x-session-id={{session.id}}" --model-prefix ""

  # Generate a config file and edit it as needed
  ${name} --init

  # Check the setup before starting: config, routing, injection and model resolution
  ${name} --dry-run

  # Same, plus a reachability probe of the upstream (never sends credentials)
  ${name} --doctor
`,

  'cli.sampleConfig': () => `{
  // Notes: this file allows // and /* */ comments and trailing commas.
  // Every field may be omitted; omitted fields fall back to their defaults.

  "listen": { "host": "127.0.0.1", "port": 9355 },

  // Upstream. "host" may also be a full URL, e.g. "https://opencode.ai"
  "upstream": {
    "protocol": "https",
    "host": "opencode.ai",
    "port": null,
    "basePath": ""            // prefix prepended to every forwarded path, e.g. "/zen/go/v1"
  },

  "request": {
    "bufferBody": true,        // must be true to rewrite the request body
    "maxBodyBytes": 67108864,
    "timeoutMs": 600000,
    // Map the client's /v1/... onto the upstream's /zen/go/v1/...
    "pathRewrite": [
      // { "pattern": "^/v1/", "replacement": "/zen/go/v1/" }
    ],
    "dropHeaders": [],
    "forwardClientSessionHeaders": true
  },

  "session": {
    "enabled": true,
    // Where to read a client-supplied session identifier from (highest priority first)
    "headerNames": ["x-opencode-session", "x-session-id", "x-conversation-id", "x-thread-id"],
    "bodyFields": ["session_id", "sessionId", "conversation_id", "conversationId"],
    // Fall back to a content fingerprint of system + the first user message
    "contentHash": {
      "enabled": true,
      "fields": ["system", "system_instruction", "instructions"],
      "includeFirstUserMessage": true
    },
    "idPrefix": "ses_",
    "idFormat": "hex26",                     // hex26 | hex | uuid | base36 | short
    "requestIdFormat": "msg_{{session.count}}",
    "maxSessions": 512,
    "ttlSeconds": 0                          // 0 means never expire
  },

  "inject": {
    // Values support templates: {{session.id}} {{session.requestId}} {{session.count}}
    //                         {{uuid}} {{random}} {{randomHex:16}} {{timestamp}} {{env.HOME}}
    "headers": {
      "x-opencode-session": "{{session.id}}",
      "x-opencode-request": "{{session.requestId}}",
      "x-opencode-client": "cli",
      "x-opencode-project": "global"
    },
    "body": {},                  // fields appended to the request body, e.g. { "temperature": 0.2 }
    "removeBodyFields": [],
    "overwrite": true            // false means never overwrite a header the client already sent
  },

  "model": {
    "enabled": true,
    "field": "model",
    // Prefixes clients add to dodge their built-in channel; stripped here
    "stripPrefixes": ["proxy-"],
    // Exact alias -> real model id. Takes precedence over prefix stripping.
    // Merged key by key over the built-in OpenCode alias table: a key here
    // overrides the built-in entry with the same name, the rest are kept.
    // Built-in entries cannot be deleted from here — override them instead.
    "map": {},
    "default": null,              // fall back to this model when nothing matches
    "warnUnmapped": true          // warn once per alias that strips to an unmapped name
  },

  // Named body transforms, applied in order. Always active, router or not.
  // Available names: noop | drop-fields | drop-empty-fields | rename-fields | clamp-max-tokens
  "transformers": {
    "enabled": [],
    "options": {
      // "drop-empty-fields": { "fields": ["tools", "temperature"] },
      // "rename-fields":     { "map": { "max_completion_tokens": "max_tokens" } },
      // "clamp-max-tokens":  { "max": 32000 }
    }
  },

  // Router buckets: pick a model and a set of transforms per request.
  // Rules are evaluated top-down, first match wins; conditions inside one rule are ANDed.
  "router": {
    "enabled": false,
    "forced": null,               // a bucket name, or null; overrides every rule (--router)
    "defaultBucket": "default",
    "buckets": {
      "default":     { "model": null, "transformers": [] },
      "background":  { "model": null, "transformers": [] },
      "think":       { "model": null, "transformers": [] },
      "longContext": { "model": null, "transformers": [] }
    },
    "rules": [
      // { "bucket": "think",       "path": "/zen/go/v1/messages" },
      // { "bucket": "think",       "modelPrefix": "proxy-think" },
      // { "bucket": "background",  "bodyField": "metadata.kind", "bodyFieldValue": "background" },
      // { "bucket": "longContext", "minBytes": 60000 }
    ]
  },

  "userAgent": "opencode/1.18.29 cli",
  "userAgentMode": "replace-generic",  // keep | replace | replace-generic

  "response": { "stream": true, "timeoutMs": 600000 },

  "lang": "en",                          // language of console output and log messages: en | zh

  "log": {
    "level": "info",                     // silent | error | warn | info | debug
    // Where logs go. null = default location ($LSP_HOME/logs or ~/.lsp/logs)<name>.log
    //                 a path = that file;  false = no log file, console only
    "file": null,
    "dir": null,                         // change the directory only, keep the default file name
    "rotate": "size",                    // size | daily | off
    "maxBytes": 5242880,                 // rotate after this many bytes (size and daily modes)
    "backups": 2,                        // how many .1/.2 backups to keep
    "keepDays": 30                       // delete logs older than N days; 0 = keep forever
  }
}
`,

  // ---------- cli.js：参数解析错误 ----------
  'cli.err.unknownArg': ({ raw }) => `Unrecognized argument: ${raw}`,
  'cli.err.unknownFlag': ({ flag }) => `Unrecognized argument: ${flag} (run --help for usage)`,
  'cli.err.missingValue': ({ flag }) => `Argument ${flag} requires a value`,
  'cli.err.notImplemented': ({ flag }) => `Argument ${flag} is not implemented yet`,
  'cli.err.pathRewriteFormat': () => '--path-rewrite expects the form "regex=>replacement"',
  'cli.err.injectFormat': () => '--inject expects the form name=value',
  'cli.err.bodyInjectFormat': () => '--body-inject expects the form key=value',
  'cli.err.modelMapFormat': () => '--model-map expects the form alias=real',

  // ---------- cli.js：启动横幅 ----------
  'cli.banner.started': ({ name, version }) => `${name} v${version} started`,
  'cli.banner.listen': ({ url }) => `  listening    ${url}`,
  'cli.banner.upstream': ({ url }) => `  upstream     ${url}`,
  'cli.banner.injectHeaders': ({ list }) => `  inject       ${list}`,
  'cli.banner.none': () => '(none)',
  'cli.banner.modelAliases': ({ prefix, map }) => `  model        ${prefix}${map}`,
  'cli.banner.stripPrefixes': ({ list }) => `strip prefixes ${list}`,
  'cli.banner.stripDisabled': () => 'prefix stripping disabled',
  'cli.banner.mapSuffix': ({ count }) => ` | ${count} mapped aliases`,
  'cli.banner.session': ({ value }) => `  session      ${value}`,
  'cli.banner.sessionValue': ({ format, requestIdFormat }) => `${format}, request id ${requestIdFormat}`,
  'cli.banner.sessionOff': () => 'disabled',
  'cli.banner.pathRewrite': ({ value }) => `  path rewrite ${value}`,
  'cli.banner.pathRewritePassthrough': () => '(none, passed through as-is)',
  'cli.banner.baseUrlHeading': () => '  ── what to put in the client Base URL ──',
  'cli.banner.baseUrlPrefixed': ({ url, basePath }) => `      ${url}     (${basePath} is appended automatically)`,
  'cli.banner.baseUrlOtherPath': ({ url }) => `      other paths ${url}/<path>`,
  'cli.banner.baseUrlRewritten': ({ url }) => `      ${url}/v1   (rewritten by the rules above)`,
  'cli.banner.baseUrlRaw': ({ url }) => `      ${url}/zen/go/v1   or the upstream path appended as-is`,
  'cli.banner.statusEndpoint': ({ url }) => `  status       ${url}/__llm_session_proxy__/status`,
  'cli.banner.configFile': ({ path }) => `  config file  ${path}`,
  'cli.banner.logFile': ({ path, detail }) => `  log file     ${path}${detail ? `  [${detail}]` : ''}`,
  'cli.banner.logFileOff': () => '  log file     (disabled, console only)',

  // ---------- 日志轮转与归档（横幅里拼接展示） ----------
  'log.rotate.size': () => 'size',
  'log.rotate.daily': () => 'daily',
  'log.rotate.off': () => 'off',
  'log.join': () => ', ',
  'log.rotateMode': ({ mode }) => `${mode} rotation`,
  'log.rotateOff': () => 'no rotation',
  'log.sizeLimit': ({ maxBytes, backups }) => `max ${maxBytes} B, ${backups} backups`,
  'log.keepDays': ({ days }) => `keep ${days} days`,
  'log.keepForever': () => 'keep forever',

  // ---------- doctor / dry-run：配置体检与路由预演 ----------
  'doctor.title': ({ name, version, mode }) => `${name} v${version} — ${mode}`,
  'doctor.mode.dryRun': () => 'dry run',
  'doctor.mode.doctor': () => 'doctor',
  'doctor.section.config': () => 'Config',
  'doctor.section.upstream': () => 'Upstream',
  'doctor.section.routing': () => 'Routing',
  'doctor.section.injection': () => 'Injection',
  'doctor.section.model': () => 'Model',
  'doctor.section.router': () => 'Router',
  'doctor.section.transformers': () => 'Transformers',
  'doctor.section.log': () => 'Log',
  'doctor.section.checks': () => 'Checks',
  'doctor.section.result': () => 'Result',
  'doctor.label.file': () => 'file',
  'doctor.label.language': () => 'language',
  'doctor.label.listen': () => 'listen',
  'doctor.label.url': () => 'url',
  'doctor.label.hostHeader': () => 'host header',
  'doctor.label.basePath': () => 'base path',
  'doctor.label.rewriteHost': () => 'rewrite host',
  'doctor.label.userAgent': () => 'user agent',
  'doctor.label.pathRewrite': () => 'path rewrite',
  'doctor.label.sessionFrom': () => 'session from',
  'doctor.label.sessionId': () => 'session id',
  'doctor.label.injectHeader': () => 'header',
  'doctor.label.injectBody': () => 'body',
  'doctor.label.removeBody': () => 'remove',
  'doctor.label.sample': () => 'sample',
  'doctor.label.strip': () => 'strip',
  'doctor.label.mapped': () => 'mapped',
  'doctor.label.mapResult': () => 'result',
  'doctor.label.map': () => 'map',
  'doctor.label.routerEnabled': () => 'enabled',
  'doctor.label.defaultBucket': () => 'default bucket',
  'doctor.label.bucketRow': ({ name }) => `bucket ${name}`,
  'doctor.label.rules': () => 'rules',
  'doctor.label.sampleRoute': () => 'sample route',
  'doctor.label.globalTransformers': () => 'global',
  'doctor.label.effectiveTransformers': () => 'effective',
  'doctor.label.availableTransformers': () => 'available',
  'doctor.label.logFile': () => 'file',
  'doctor.label.rotation': () => 'rotation',
  'doctor.label.upstreamCheck': () => 'upstream',
  'doctor.label.portCheck': () => 'listen port',
  'doctor.label.credentials': () => 'credentials',
  'doctor.value.none': () => '(none)',
  'doctor.value.passthrough': () => '(none, passed through as-is)',
  'doctor.value.yes': () => 'yes',
  'doctor.value.no': () => 'no',
  'doctor.value.forced': ({ bucket }) => `yes — forced to "${bucket}"`,
  'doctor.value.disabled': ({ bucket }) => `${bucket} (router disabled)`,
  'doctor.value.noRules': () => '(no rules)',
  'doctor.value.routeBy': ({ bucket, index, path }) => `${bucket}  (rule #${index}, sample path ${path})`,
  'doctor.value.routeDefault': ({ bucket, path }) => `${bucket}  (default bucket, no rule matched ${path})`,
  'doctor.value.routeForced': ({ bucket }) => `${bucket}  (forced by --router)`,
  'doctor.value.ua': ({ ua, mode }) => `${ua} (mode ${mode})`,
  'doctor.value.sessionFrom': ({ headers, body }) => `header ${headers}; body ${body}`,
  'doctor.value.mapSize': ({ builtin, overrides }) => `${builtin} built-in aliases, ${overrides} overrides`,
  'doctor.value.headerRow': ({ name, template, rendered }) => `${name} = ${template}  ->  ${rendered}`,
  'doctor.model.stripped': ({ prefix, resolved }) => `prefix "${prefix}" -> ${resolved}`,
  'doctor.model.mapped': ({ alias, resolved }) => `${alias} -> ${resolved}`,
  'doctor.model.resultMapped': ({ resolved }) => `${resolved}  (mapped)`,
  'doctor.model.resultDefault': ({ resolved }) => `${resolved}  (from model.default)`,
  'doctor.model.resultPassthrough': ({ resolved }) =>
    `${resolved}  (no prefix matched, forwarded as-is — the client sent a real model id)`,
  'doctor.model.resultStrippedUnmapped': ({ resolved }) =>
    `${resolved}  (prefix stripped, NO mapping — sent upstream as-is; this is what the "model not found" errors come from)`,
  'doctor.check.dnsOk': ({ host, address }) => `dns ok (${host} -> ${address})`,
  'doctor.check.dnsFail': ({ host, message }) => `dns FAILED (${host}: ${message})`,
  'doctor.check.tcpOk': ({ host, port, ms }) => `tcp ok (${host}:${port}, ${ms} ms)`,
  'doctor.check.tcpFail': ({ host, port, message }) => `tcp FAILED (${host}:${port}: ${message})`,
  'doctor.check.tlsOk': ({ detail }) => `tls ok${detail}`,
  'doctor.check.tlsFail': ({ message }) => `tls FAILED (${message})`,
  'doctor.check.timeout': ({ ms }) => `timeout after ${ms} ms`,
  'doctor.check.tlsUnverified': () => ', certificate NOT verified by the system CA store',
  'doctor.check.portFree': ({ port }) => `port ${port} is free`,
  'doctor.check.portBusy': ({ port }) =>
    `port ${port} is already in use — is another instance already running?`,
  'doctor.check.credentials': ({ header }) =>
    `the proxy never injects credentials; ${header} must come from the client`,
  'doctor.check.skipped': () => 'not checked in dry-run mode (use --doctor)',
  'doctor.result.ok': () => 'OK — the configuration is valid.',
  'doctor.result.okDoctor': () => 'OK — the configuration is valid and every check passed.',
  'doctor.result.fail': ({ count }) => `FAILED — ${count} problem(s) above must be fixed first.`,
  'doctor.warnings': ({ count, list }) => `${count} warning(s):\n  - ${list}`,
  'doctor.problems': ({ count, list }) => `${count} problem(s):\n  - ${list}`,
  'doctor.warn.modelMapEmpty': () =>
    'model.map is empty while prefix stripping is enabled — aliases such as "proxy-deepseek" will be forwarded stripped and verbatim',
  'doctor.warn.portBusy': ({ port }) => `listen port ${port} is already in use`,
  'doctor.warn.routerEmpty': () =>
    'router is enabled but no rule and no bucket is configured — every request falls through to the default bucket, so the routing layer costs a check and decides nothing',
  'doctor.fail.dns': ({ host }) => `cannot resolve upstream host ${host}`,
  'doctor.fail.connect': ({ host, port }) => `cannot connect to ${host}:${port}`,
  'doctor.fail.tls': () => 'TLS handshake failed',
  'doctor.fail.unresolvedAlias': ({ alias, resolved }) =>
    `alias "${alias}" strips to "${resolved}", which matches no model.map entry and no model.default — ` +
    `the upstream will most likely reject it as an unknown model`,

  // ---------- router.js：路由分桶 ----------
  'router.ruleNoMatch': () => '(no matcher — this rule never applies)',

  // ---------- transformers.js：命名变换 ----------
  'transformer.noop': () => 'do nothing; useful for verifying the pipeline end to end',
  'transformer.dropFields': () => 'delete the body fields listed in options.fields (dot paths allowed)',
  'transformer.dropEmptyFields': () =>
    'delete fields whose value is null, "", [] or {} — upstreams commonly reject empty arrays such as tools: []',
  'transformer.renameFields': () =>
    'rename body fields per options.map, e.g. max_completion_tokens -> max_tokens',
  'transformer.clampMaxTokens': () => 'cap max_tokens / max_completion_tokens at options.max',

  // ---------- cli.js：进程级兜底 ----------
  'cli.guard.uncaught': ({ kind, detail }) => `[${kind}] uncaught error (process continues): ${detail}`,
  'cli.guard.tooMany': ({ kind, seconds, count }) =>
    `[${kind}] ${count} occurrences within ${seconds}s — persistent failure, exiting`,

  // ---------- cli.js：--init 与生命周期 ----------
  'cli.init.exists': ({ target }) => `File already exists, not overwritten: ${target}`,
  'cli.init.created': ({ target, name }) =>
    `Sample config written: ${target}\nEdit it as needed, then start with: ${name} --config "${target}"\n`,
  'cli.startFailed': ({ message }) => `Failed to start: ${message}`,
  'cli.portInUse': ({ port, name, nextPort }) =>
    `Port ${port} is already in use, try another: ${name} --port ${nextPort}`,
  'cli.shutdown.signal': ({ signal }) => `Received ${signal}, shutting down…`,
  'cli.shutdown.done': () => 'Stopped',

  // ---------- proxy.js：回给客户端的错误消息 ----------
  'proxy.err.bodyTooLarge': ({ maxBytes }) => `Request body exceeds the limit of ${maxBytes} bytes`,
  'proxy.err.clientAbortedBody': () => 'Client disconnected before the request body was fully read',
  'proxy.err.internal': ({ message }) => `Proxy failed to handle the request: ${message}`,
  'proxy.err.badRequestTarget': ({ url, host }) =>
    `Cannot parse the request target: ${url} (Host header is ${host})`,
  'proxy.err.unknownEndpoint': ({ pathname }) => `Unknown local endpoint: ${pathname}`,
  'proxy.err.buildUpstream': ({ message }) => `Cannot build the upstream request: ${message}`,
  'proxy.err.upstreamTimeout': ({ timeoutMs }) => `Upstream did not respond within ${timeoutMs}ms`,
  'proxy.err.upstreamUnreachable': ({ origin, message }) => `Cannot reach upstream ${origin}: ${message}`,
  'proxy.err.clientAborted': () => 'Client aborted the request',

  // ---------- proxy.js：日志 ----------
  'proxy.log.respondFailed': ({ message }) => `[client] failed to write the response (client may be gone): ${message}`,
  'proxy.log.badReasonPhrase': ({ value }) =>
    `[res] upstream reason phrase has illegal characters, using the default instead: ${value}`,
  'proxy.log.writeHeadRetry': ({ message }) => `[res] writeHead failed, dropping suspect headers and retrying: ${message}`,
  'proxy.log.dropIllegalHeader': ({ key }) => `[res] dropped illegal response header: ${key}`,
  'proxy.log.writeHeadGaveUp': ({ message }) => `[res] response headers still cannot be written, giving up: ${message}`,
  'proxy.log.requestFailed': ({ method, url, detail }) =>
    `[request-failed] ${method} ${url} threw while handling the request (caught, process continues): ${detail}`,
  'proxy.log.resStreamError': ({ message }) => `[client] response stream error (client may be gone): ${message}`,
  'proxy.log.reqStreamError': ({ message }) => `[client] request stream error: ${message}`,
  'proxy.log.badRequestTarget': ({ url, host }) => `[req] cannot parse request target ${url} (Host=${host})`,
  'proxy.log.readBodyFailed': ({ method, url, message }) => `[req] ${method} ${url} failed to read the body: ${message}`,
  'proxy.log.buildUpstreamFailed': ({ method, url, targetPath, message }) =>
    `[proxy-error] failed to build the upstream request ${method} ${url} -> ${targetPath}: ${message}`,
  'proxy.log.upstreamFailed': ({ method, url, targetPath, message }) =>
    `[proxy-error] ${method} ${url} -> ${targetPath}: ${message}`,
  'proxy.log.writeUpstreamFailed': ({ message }) => `[proxy-error] failed to write the upstream request: ${message}`,
  'proxy.log.upstreamHeaderDropped': ({ key }) => `[res] upstream response header has illegal characters, dropped: ${key}`,
  'proxy.log.upstreamStreamError': ({ message }) => `[res] upstream response stream error: ${message}`,
  'proxy.log.pipeFailed': ({ message }) => `[res] pipe failed: ${message}`,
  'proxy.log.bufferWriteFailed': ({ message }) => `[res] failed to write the buffered response: ${message}`,
  'proxy.log.unmappedModelAlias': ({ alias, prefix, resolved }) =>
    `[model] alias "${alias}" matched no mapping after stripping "${prefix}" — forwarding "${resolved}" to the upstream as-is. ` +
    `Add model.map["${resolved}"], or have the client send the real model id.`,
  'proxy.log.clientParseFailed': ({ code }) => `[client] failed to parse the request: ${code}`,
  'proxy.log.transformerSkipped': ({ name, bucket }) =>
    `[transformer] "${name}" from bucket "${bucket}" is not a registered request-phase transformer — skipped`,
  'proxy.log.serverError': ({ detail }) => `[server] server error (process continues): ${detail}`,
};

const zh = {
  // ---------- config.js ----------
  'config.parseFailed': ({ source, message }) => `配置文件解析失败（${source}）: ${message}`,
  'config.rootNotObject': ({ path }) => `配置文件根节点必须是对象（${path}）`,
  'config.envNotNumber': ({ key, raw }) => `环境变量 ${key} 需要是数字，收到 "${raw}"`,
  'config.badRegex': ({ pattern, message }) => `pathRewrite 里的正则不合法 "${pattern}": ${message}`,
  'config.badPort': ({ port }) => `listen.port 不合法: ${port}`,
  'config.emptyHost': () => 'upstream.host 不能为空',
  'config.badProtocol': ({ protocol }) => `upstream.protocol 只支持 http / https，收到 ${protocol}`,
  'config.badIdFormat': ({ format }) => `session.idFormat 不支持: ${format}`,
  'config.injectNotObject': () => 'inject.headers 必须是对象（值为模板字符串）',
  'config.badLang': ({ lang }) => `不支持的 lang: ${lang}（可选 ${SUPPORTED_LANGS.join(' | ')}）`,
  'config.validationFailed': ({ list }) => `配置校验失败:\n  - ${list}`,
  'config.badLog': () => 'log 必须是对象',
  'config.badLogFile': ({ file }) => `log.file 必须是路径字符串或 false（只输出到控制台），收到 ${file}`,
  'config.badLogDir': ({ dir }) => `log.dir 必须是路径字符串或 null，收到 ${dir}`,
  'config.badLogRotate': ({ rotate, modes }) => `log.rotate 只能是 ${modes}，收到 ${rotate}`,
  'config.badLogLevel': ({ level, levels }) => `log.level 只能是 ${levels}，收到 ${level}`,
  'config.badLogNumber': ({ key, value }) => `${key} 必须是非负数，收到 ${value}`,
  'config.badModel': () => 'model 必须是对象',
  'config.badModelMap': ({ value }) => `model.map 必须是 { 别名: 真实模型 ID } 形式的对象，收到 ${value}`,
  'config.badModelMapEntry': ({ alias, value }) =>
    `model.map["${alias}"] 必须是非空的模型 ID 字符串，收到 ${value}`,
  'config.badModelField': ({ field }) => `model.field 必须是非空字符串，收到 ${field}`,
  'config.badRouter': () => 'router 必须是对象',
  'config.badRouterBuckets': () => 'router.buckets 至少要声明一个桶',
  'config.badRouterDefaultBucket': ({ bucket, buckets }) =>
    `router.defaultBucket ${bucket} 不在 router.buckets 里（可用：${buckets}）`,
  'config.badRouterForced': ({ bucket, buckets }) =>
    `--router 指定的「${bucket}」不是已声明的桶（可用：${buckets}）`,
  'config.badRouterRuleBucket': ({ index, bucket, buckets }) =>
    `router.rules[${index}] 指向的桶「${bucket}」未声明（可用：${buckets}）`,
  'config.badRouterRuleNoMatch': ({ index, bucket }) =>
    `router.rules[${index}]（桶「${bucket}」）没有任何匹配条件 —— 请补 path / modelPrefix / bodyField / minBytes / maxBytes 之一，否则这条规则永远不会生效`,
  'config.badRouterRuleBytes': ({ index, key, value }) =>
    `router.rules[${index}].${key} 必须是非负数字，收到 ${value}`,
  'config.badTransformerName': ({ where, name, known }) =>
    `${where}：「${name}」不是已注册的变换（可用：${known}）`,
  'config.badTransformerOptions': () => 'transformers.options 必须是以变换名为键的对象',
  'config.badTransformers': () => 'transformers 必须是带 enabled 与 options 的对象',
  'config.badTransformerEnabled': () => 'transformers.enabled 必须是变换名数组',

  // ---------- cli.js ----------
  'cli.help': ({ name, version, defaults }) => `
${name} v${version}
可自定义参数的 LLM 本地反向代理：自动生成/透传会话 ID、注入任意请求头、重写模型别名与请求路径。

用法
  ${name} [选项]

常用选项
  -c, --config <file>          读取 JSON 配置文件（支持 // 与 /* */ 注释、尾随逗号）
  -p, --port <number>          监听端口（默认 ${defaults.port}）
      --host <addr>            监听地址（默认 ${defaults.host}）
  -u, --upstream <url>         上游地址，如 https://opencode.ai 或 host:port
      --base-path <path>       转发路径统一前缀，如 /zen/go/v1
      --path-rewrite <a=>b>    路径重写（正则 => 替换），可重复
      --inject <name=value>    追加/覆盖注入的请求头，可重复。值支持模板，如 {{session.id}}
      --body-inject <k=v>      往请求体注入字段（支持点路径与模板），可重复
      --model-prefix <prefix>  需要剥离的模型名前缀，可重复（默认 proxy-）
      --model-map <a=b>        模型名精确映射，可重复（优先于前缀剥离，与内置别名表逐键合并）
      --transformer <name>     挂一个命名请求体变换，可重复（整体替换，只写名字即启用）。
                               可用：noop | drop-fields | drop-empty-fields | rename-fields | clamp-max-tokens
      --router <bucket>        强制所有请求走指定桶，忽略规则
      --no-router              关闭路由分桶
      --session-header <name>  追加"从哪个请求头读客户端会话"，可重复
      --session-field <path>   追加"从哪个请求体字段读客户端会话"，可重复
      --session-id-format <f>  会话 ID 格式：hex26 | hex | uuid | base36 | short
      --request-id-format <t>  请求号模板，如 "msg_{{session.count}}"
      --no-session             完全关闭会话 ID 注入
      --no-stream              关闭流式透传（整体缓冲后返回）
      --timeout <ms>           上游请求超时（默认 ${defaults.timeoutMs}）
      --max-body <bytes>       请求体上限（默认 ${defaults.maxBodyBytes}）
  -l, --lang <en|zh>            控制台与日志文案语言（默认 en）
      --log-level <level>       日志级别：silent | error | warn | info | debug
      --log-file <file>         日志文件（默认 ~/.lsp/logs/${name}.log）
      --no-log-file             不写日志文件（只输出到控制台）
      --log-dir <dir>           默认日志文件所在目录
      --log-rotate <mode>       轮转方式：size | daily | off（默认 size）
      --log-keep-days <days>    自动删除超过该天数的历史日志（默认 30，0 为永久保留）

本地工具
      --print-config           打印合并后的最终配置并退出
      --dry-run                检查配置并预演一次请求会怎么走，不产生任何网络请求
      --doctor                 同 --dry-run，另加上游可达性与监听端口检查；有问题时退出码非 0
      --model <id>             --dry-run / --doctor 演示用的样例模型名（默认从映射表推导）
      --init [file]            生成一份带注释的示例配置（默认 ./${name}.config.json）
  -h, --help                   显示帮助
  -v, --version                显示版本

示例
  # OpenCode Go：客户端 Base URL 填 http://127.0.0.1:9355/zen/go/v1
  ${name}

  # 把客户端的 /v1/... 映射到上游的 /zen/go/v1/...
  ${name} -u https://opencode.ai --path-rewrite "^/v1/=>/zen/go/v1/"

  # 任意自建上游：换地址 + 换注入头
  ${name} -u https://api.example.com --inject "x-api-version=2026-01-01" \\
          --inject "x-session-id={{session.id}}" --model-prefix ""

  # 生成配置文件后按需修改
  ${name} --init

  # 启动前先体检：配置、路由、注入与模型解析
  ${name} --dry-run

  # 同上，另外探一次上游可达性（不会发送任何凭据）
  ${name} --doctor
`,

  'cli.sampleConfig': () => `{
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
    // 客户端为避开内置通道而加的前缀，这里剥掉
    "stripPrefixes": ["proxy-"],
    // 别名 -> 真实模型 ID，优先于前缀剥离。
    // 与内置的 OpenCode 别名表**逐键合并**：同名的以这里为准，其余保留。
    // 内置项删不掉，想改就覆盖同名的键。
    "map": {},
    "default": null,              // 全都命中不了时的兜底模型
    "warnUnmapped": true          // 别名剥完前缀仍无映射时，每个别名告警一次
  },

  // 命名请求体变换，按数组顺序执行。与 router 无关，始终生效。
  // 可用名字：noop | drop-fields | drop-empty-fields | rename-fields | clamp-max-tokens
  "transformers": {
    "enabled": [],
    "options": {
      // "drop-empty-fields": { "fields": ["tools", "temperature"] },
      // "rename-fields":     { "map": { "max_completion_tokens": "max_tokens" } },
      // "clamp-max-tokens":  { "max": 32000 }
    }
  },

  // 路由分桶：按请求的性质决定用哪个模型、挂哪些变换。
  // 规则自上而下匹配，首个命中生效；同一条规则内的多个条件是 AND。
  "router": {
    "enabled": false,
    "forced": null,               // 桶名或 null；写了就压过所有规则（对应 --router）
    "defaultBucket": "default",
    "buckets": {
      "default":     { "model": null, "transformers": [] },
      "background":  { "model": null, "transformers": [] },
      "think":       { "model": null, "transformers": [] },
      "longContext": { "model": null, "transformers": [] }
    },
    "rules": [
      // { "bucket": "think",       "path": "/zen/go/v1/messages" },
      // { "bucket": "think",       "modelPrefix": "proxy-think" },
      // { "bucket": "background",  "bodyField": "metadata.kind", "bodyFieldValue": "background" },
      // { "bucket": "longContext", "minBytes": 60000 }
    ]
  },

  "userAgent": "opencode/1.18.29 cli",
  "userAgentMode": "replace-generic",  // keep | replace | replace-generic

  "response": { "stream": true, "timeoutMs": 600000 },

  "lang": "en",                          // 控制台与日志文案语言：en | zh

  "log": {
    "level": "info",                     // silent | error | warn | info | debug
    // 日志写到哪里。null = 默认位置（$LSP_HOME/logs 或 ~/.lsp/logs）下的 <包名>.log
    //              路径 = 写到该文件；false = 不写文件，只输出到控制台
    "file": null,
    "dir": null,                         // 只想换目录、文件名保持默认时用它
    "rotate": "size",                    // size | daily | off
    "maxBytes": 5242880,                 // 超过该字节数就轮转（size 与 daily 都生效）
    "backups": 2,                        // 保留几份 .1/.2 备份
    "keepDays": 30                       // 自动删除超过 N 天的历史日志；0 表示永久保留
  }
}
`,

  // ---------- cli.js：参数解析错误 ----------
  'cli.err.unknownArg': ({ raw }) => `无法识别的参数: ${raw}`,
  'cli.err.unknownFlag': ({ flag }) => `无法识别的参数: ${flag}（用 --help 查看用法）`,
  'cli.err.missingValue': ({ flag }) => `参数 ${flag} 缺少取值`,
  'cli.err.notImplemented': ({ flag }) => `参数 ${flag} 尚未实现`,
  'cli.err.pathRewriteFormat': () => '--path-rewrite 需要 "正则=>替换" 形式',
  'cli.err.injectFormat': () => '--inject 需要 name=value 形式',
  'cli.err.bodyInjectFormat': () => '--body-inject 需要 key=value 形式',
  'cli.err.modelMapFormat': () => '--model-map 需要 alias=real 形式',

  // ---------- cli.js：启动横幅 ----------
  'cli.banner.started': ({ name, version }) => `${name} v${version} 已启动`,
  'cli.banner.listen': ({ url }) => `  监听地址    ${url}`,
  'cli.banner.upstream': ({ url }) => `  上游        ${url}`,
  'cli.banner.injectHeaders': ({ list }) => `  注入请求头  ${list}`,
  'cli.banner.none': () => '(无)',
  'cli.banner.modelAliases': ({ prefix, map }) => `  模型别名    ${prefix}${map}`,
  'cli.banner.stripPrefixes': ({ list }) => `剥离前缀 ${list}`,
  'cli.banner.stripDisabled': () => '未启用前缀剥离',
  'cli.banner.mapSuffix': ({ count }) => ` | 已映射 ${count} 个别名`,
  'cli.banner.session': ({ value }) => `  会话 ID     ${value}`,
  'cli.banner.sessionValue': ({ format, requestIdFormat }) => `${format}，请求号 ${requestIdFormat}`,
  'cli.banner.sessionOff': () => '已关闭',
  'cli.banner.pathRewrite': ({ value }) => `  路径重写    ${value}`,
  'cli.banner.pathRewritePassthrough': () => '(无，原样透传)',
  'cli.banner.baseUrlHeading': () => '  ── 客户端 Base URL 怎么填 ──',
  'cli.banner.baseUrlPrefixed': ({ url, basePath }) => `      ${url}     （自动补上 ${basePath}）`,
  'cli.banner.baseUrlOtherPath': ({ url }) => `      其他路径   ${url}/原路径`,
  'cli.banner.baseUrlRewritten': ({ url }) => `      ${url}/v1   （按上面的重写规则转到上游）`,
  'cli.banner.baseUrlRaw': ({ url }) => `      ${url}/zen/go/v1   或按上游路径原样拼接`,
  'cli.banner.statusEndpoint': ({ url }) => `  状态端点    ${url}/__llm_session_proxy__/status`,
  'cli.banner.configFile': ({ path }) => `  配置文件    ${path}`,
  'cli.banner.logFile': ({ path, detail }) => `  日志文件    ${path}${detail ? `  [${detail}]` : ''}`,
  'cli.banner.logFileOff': () => '  日志文件    （已关闭，只输出到控制台）',

  // ---------- 日志轮转与归档（横幅里拼接展示） ----------
  'log.rotate.size': () => '按大小',
  'log.rotate.daily': () => '按日期',
  'log.rotate.off': () => '关闭',
  'log.join': () => '，',
  'log.rotateMode': ({ mode }) => `${mode}轮转`,
  'log.rotateOff': () => '不轮转',
  'log.sizeLimit': ({ maxBytes, backups }) => `单文件 ${maxBytes} 字节，保留 ${backups} 份`,
  'log.keepDays': ({ days }) => `保留 ${days} 天`,
  'log.keepForever': () => '永久保留',

  // ---------- doctor / dry-run：配置体检与路由预演 ----------
  'doctor.title': ({ name, version, mode }) => `${name} v${version} —— ${mode}`,
  'doctor.mode.dryRun': () => '试运行',
  'doctor.mode.doctor': () => '体检',
  'doctor.section.config': () => '配置',
  'doctor.section.upstream': () => '上游',
  'doctor.section.routing': () => '路由',
  'doctor.section.injection': () => '注入',
  'doctor.section.model': () => '模型',
  'doctor.section.router': () => '路由分桶',
  'doctor.section.transformers': () => '变换',
  'doctor.section.log': () => '日志',
  'doctor.section.checks': () => '检查',
  'doctor.section.result': () => '结果',
  'doctor.label.file': () => '文件',
  'doctor.label.language': () => '语言',
  'doctor.label.listen': () => '监听',
  'doctor.label.url': () => '地址',
  'doctor.label.hostHeader': () => 'Host 头',
  'doctor.label.basePath': () => '路径前缀',
  'doctor.label.rewriteHost': () => '改写 Host',
  'doctor.label.userAgent': () => 'UA',
  'doctor.label.pathRewrite': () => '路径重写',
  'doctor.label.sessionFrom': () => '会话来源',
  'doctor.label.sessionId': () => '会话 ID',
  'doctor.label.injectHeader': () => '请求头',
  'doctor.label.injectBody': () => '请求体',
  'doctor.label.removeBody': () => '删除字段',
  'doctor.label.sample': () => '样例',
  'doctor.label.strip': () => '剥离',
  'doctor.label.mapped': () => '映射',
  'doctor.label.mapResult': () => '结果',
  'doctor.label.map': () => '映射表',
  'doctor.label.routerEnabled': () => '启用',
  'doctor.label.defaultBucket': () => '默认桶',
  'doctor.label.bucketRow': ({ name }) => `桶 ${name}`,
  'doctor.label.rules': () => '规则',
  'doctor.label.sampleRoute': () => '样例路由',
  'doctor.label.globalTransformers': () => '全局',
  'doctor.label.effectiveTransformers': () => '生效',
  'doctor.label.availableTransformers': () => '可用',
  'doctor.label.logFile': () => '文件',
  'doctor.label.rotation': () => '轮转',
  'doctor.label.upstreamCheck': () => '上游',
  'doctor.label.portCheck': () => '监听端口',
  'doctor.label.credentials': () => '凭据',
  'doctor.value.none': () => '（无）',
  'doctor.value.passthrough': () => '（无，原样透传）',
  'doctor.value.yes': () => '是',
  'doctor.value.no': () => '否',
  'doctor.value.forced': ({ bucket }) => `是 —— 已强制为「${bucket}」`,
  'doctor.value.disabled': ({ bucket }) => `${bucket}（路由已关闭）`,
  'doctor.value.noRules': () => '（无规则）',
  'doctor.value.routeBy': ({ bucket, index, path }) => `${bucket}（规则 #${index}，样例路径 ${path}）`,
  'doctor.value.routeDefault': ({ bucket, path }) => `${bucket}（默认桶，${path} 未命中任何规则）`,
  'doctor.value.routeForced': ({ bucket }) => `${bucket}（由 --router 强制）`,
  'doctor.value.ua': ({ ua, mode }) => `${ua}（模式 ${mode}）`,
  'doctor.value.sessionFrom': ({ headers, body }) => `请求头 ${headers}；请求体 ${body}`,
  'doctor.value.mapSize': ({ builtin, overrides }) => `内置 ${builtin} 条，覆盖 ${overrides} 条`,
  'doctor.value.headerRow': ({ name, template, rendered }) => `${name} = ${template}  ->  ${rendered}`,
  'doctor.model.stripped': ({ prefix, resolved }) => `前缀 "${prefix}" -> ${resolved}`,
  'doctor.model.mapped': ({ alias, resolved }) => `${alias} -> ${resolved}`,
  'doctor.model.resultMapped': ({ resolved }) => `${resolved}  （命中映射）`,
  'doctor.model.resultDefault': ({ resolved }) => `${resolved}  （来自 model.default）`,
  'doctor.model.resultPassthrough': ({ resolved }) =>
    `${resolved}  （未匹配任何前缀，原样转发 —— 客户端填的是真实模型 ID）`,
  'doctor.model.resultStrippedUnmapped': ({ resolved }) =>
    `${resolved}  （剥了前缀却没有映射，原样发上游 —— 「模型不存在」多半就是这么来的）`,
  'doctor.check.dnsOk': ({ host, address }) => `DNS 正常（${host} -> ${address}）`,
  'doctor.check.dnsFail': ({ host, message }) => `DNS 失败（${host}：${message}）`,
  'doctor.check.tcpOk': ({ host, port, ms }) => `TCP 正常（${host}:${port}，${ms} ms）`,
  'doctor.check.tcpFail': ({ host, port, message }) => `TCP 失败（${host}:${port}：${message}）`,
  'doctor.check.tlsOk': ({ detail }) => `TLS 正常${detail}`,
  'doctor.check.tlsFail': ({ message }) => `TLS 失败（${message}）`,
  'doctor.check.timeout': ({ ms }) => `超时（${ms} ms）`,
  'doctor.check.tlsUnverified': () => '，证书未通过系统 CA 校验',
  'doctor.check.portFree': ({ port }) => `端口 ${port} 空闲`,
  'doctor.check.portBusy': ({ port }) => `端口 ${port} 已被占用 —— 是不是已经跑着一个实例了？`,
  'doctor.check.credentials': ({ header }) => `代理从不注入凭据；${header} 需要客户端自己带`,
  'doctor.check.skipped': () => '试运行模式不检查（用 --doctor）',
  'doctor.result.ok': () => '通过 —— 配置有效。',
  'doctor.result.okDoctor': () => '通过 —— 配置有效，检查全部通过。',
  'doctor.result.fail': ({ count }) => `未通过 —— 上面 ${count} 个问题需要先解决。`,
  'doctor.warnings': ({ count, list }) => `${count} 条警告：\n  - ${list}`,
  'doctor.problems': ({ count, list }) => `${count} 个问题：\n  - ${list}`,
  'doctor.warn.modelMapEmpty': () =>
    '前缀剥离已启用但 model.map 为空 —— proxy-deepseek 这类别名会被剥完前缀后原样转发',
  'doctor.warn.portBusy': ({ port }) => `监听端口 ${port} 已被占用`,
  'doctor.warn.routerEmpty': () =>
    '路由已开启，但既没有规则、也没有任何桶配了模型或变换 —— 所有请求都会落到默认桶，等于白跑一层判定',
  'doctor.fail.dns': ({ host }) => `无法解析上游主机名 ${host}`,
  'doctor.fail.connect': ({ host, port }) => `无法连接 ${host}:${port}`,
  'doctor.fail.tls': () => 'TLS 握手失败',
  'doctor.fail.unresolvedAlias': ({ alias, resolved }) =>
    `别名 "${alias}" 剥完前缀是 "${resolved}"，既没命中 model.map 也没有 model.default —— ` +
    `上游极可能直接以「未知模型」拒绝`,

  // ---------- cli.js：进程级兜底 ----------
  // ---------- router.js：路由分桶 ----------
  'router.ruleNoMatch': () => '（没有匹配条件 —— 这条规则永远不会生效）',

  // ---------- transformers.js：命名变换 ----------
  'transformer.noop': () => '什么都不做；用来端到端验证流水线本身',
  'transformer.dropFields': () => '删除 options.fields 列出的请求体字段（支持点路径）',
  'transformer.dropEmptyFields': () =>
    '删除值为 null、""、[] 或 {} 的字段 —— 上游普遍不接受空数组，比如 tools: []',
  'transformer.renameFields': () =>
    '按 options.map 重命名字段，例如 max_completion_tokens -> max_tokens',
  'transformer.clampMaxTokens': () => '把 max_tokens / max_completion_tokens 压到 options.max 以内',

  // ---------- cli.js：进程级兜底 ----------
  'cli.guard.uncaught': ({ kind, detail }) => `[${kind}] 未捕获的错误（进程继续运行）: ${detail}`,
  'cli.guard.tooMany': ({ kind, seconds, count }) =>
    `[${kind}] ${seconds} 秒内已发生 ${count} 次，判定为持续故障，主动退出`,

  // ---------- cli.js：--init 与生命周期 ----------
  'cli.init.exists': ({ target }) => `文件已存在，未覆盖: ${target}`,
  'cli.init.created': ({ target, name }) => `已生成示例配置: ${target}\n按需修改后用 ${name} --config "${target}" 启动。\n`,
  'cli.startFailed': ({ message }) => `启动失败: ${message}`,
  'cli.portInUse': ({ port, name, nextPort }) => `端口 ${port} 已被占用，换一个：${name} --port ${nextPort}`,
  'cli.shutdown.signal': ({ signal }) => `收到 ${signal}，正在关闭…`,
  'cli.shutdown.done': () => '已停止',

  // ---------- proxy.js：回给客户端的错误消息 ----------
  'proxy.err.bodyTooLarge': ({ maxBytes }) => `请求体超过上限 ${maxBytes} 字节`,
  'proxy.err.clientAbortedBody': () => '客户端在请求体读完前断开',
  'proxy.err.internal': ({ message }) => `代理处理请求时出错: ${message}`,
  'proxy.err.badRequestTarget': ({ url, host }) => `无法解析请求目标: ${url}（Host 头为 ${host}）`,
  'proxy.err.unknownEndpoint': ({ pathname }) => `未知的本地端点: ${pathname}`,
  'proxy.err.buildUpstream': ({ message }) => `无法构造上游请求: ${message}`,
  'proxy.err.upstreamTimeout': ({ timeoutMs }) => `上游 ${timeoutMs}ms 未响应，已超时`,
  'proxy.err.upstreamUnreachable': ({ origin, message }) => `无法连接上游 ${origin}: ${message}`,
  'proxy.err.clientAborted': () => '客户端中断了请求',

  // ---------- proxy.js：日志 ----------
  'proxy.log.respondFailed': ({ message }) => `[client] 回写响应失败（客户端可能已断开）: ${message}`,
  'proxy.log.badReasonPhrase': ({ value }) => `[res] 上游 reason phrase 含非法字符，已改用默认短语: ${value}`,
  'proxy.log.writeHeadRetry': ({ message }) => `[res] 写响应头失败，丢弃可疑头后重试: ${message}`,
  'proxy.log.dropIllegalHeader': ({ key }) => `[res] 丢弃非法响应头: ${key}`,
  'proxy.log.writeHeadGaveUp': ({ message }) => `[res] 响应头仍无法写出，放弃本次响应: ${message}`,
  'proxy.log.requestFailed': ({ method, url, detail }) =>
    `[request-failed] ${method} ${url} 处理请求时抛错（已拦截，进程继续）: ${detail}`,
  'proxy.log.resStreamError': ({ message }) => `[client] 响应流出错（客户端可能已断开）: ${message}`,
  'proxy.log.reqStreamError': ({ message }) => `[client] 请求流出错: ${message}`,
  'proxy.log.badRequestTarget': ({ url, host }) => `[req] 无法解析请求目标 ${url}（Host=${host}）`,
  'proxy.log.readBodyFailed': ({ method, url, message }) => `[req] ${method} ${url} 读取请求体失败: ${message}`,
  'proxy.log.buildUpstreamFailed': ({ method, url, targetPath, message }) =>
    `[proxy-error] 组装上游请求失败 ${method} ${url} -> ${targetPath}: ${message}`,
  'proxy.log.upstreamFailed': ({ method, url, targetPath, message }) =>
    `[proxy-error] ${method} ${url} -> ${targetPath}: ${message}`,
  'proxy.log.writeUpstreamFailed': ({ message }) => `[proxy-error] 写入上游请求失败: ${message}`,
  'proxy.log.upstreamHeaderDropped': ({ key }) => `[res] 上游响应头含非法字符，已丢弃: ${key}`,
  'proxy.log.upstreamStreamError': ({ message }) => `[res] 上游响应流出错: ${message}`,
  'proxy.log.pipeFailed': ({ message }) => `[res] 管道连接失败: ${message}`,
  'proxy.log.bufferWriteFailed': ({ message }) => `[res] 回写缓冲响应失败: ${message}`,
  'proxy.log.unmappedModelAlias': ({ alias, prefix, resolved }) =>
    `[model] 别名 "${alias}" 剥掉前缀 "${prefix}" 后没有命中任何映射 —— 会把 "${resolved}" 原样发给上游。` +
    `请补 model.map["${resolved}"]，或让客户端直接填真实模型 ID。`,
  'proxy.log.clientParseFailed': ({ code }) => `[client] 解析请求失败: ${code}`,
  'proxy.log.transformerSkipped': ({ name, bucket }) =>
    `[transformer] 桶 "${bucket}" 挂的 "${name}" 不是已注册的请求相位变换 —— 已跳过`,
  'proxy.log.serverError': ({ detail }) => `[server] 服务器错误（进程继续）: ${detail}`,
};

export const MESSAGES = { en, zh };

/** 文案 key 清单（测试用它保证两套语言不漂移）。 */
export const MESSAGE_KEYS = Object.keys(en);

let currentLang = DEFAULT_LANG;

/** 切换当前语言，返回归一化后的语言代码；无法识别时退回默认语言。 */
export function setLang(lang) {
  currentLang = normalizeLang(lang) || DEFAULT_LANG;
  return currentLang;
}

export function getLang() {
  return currentLang;
}

/**
 * 取一条文案。params 是给函数型文案用的具名参数。
 * token 不存在时原样返回 token，避免把 `undefined` 打给用户。
 */
export function t(key, params) {
  const entry = (MESSAGES[currentLang] || MESSAGES.en)[key];
  const fallback = MESSAGES.en[key];
  const value = entry === undefined ? fallback : entry;
  if (value === undefined) return key;
  return typeof value === 'function' ? value(params || {}) : value;
}
