# llm-session-proxy

[![npm version](https://img.shields.io/npm/v/llm-session-proxy.svg)](https://www.npmjs.com/package/llm-session-proxy)
[![Publish to npm](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml/badge.svg)](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-1f6feb)](https://www.ianzhang.cn/llm-session-proxy/zh/)

*中文 · [English](README.md) · [在线文档](https://www.ianzhang.cn/llm-session-proxy/zh/) · [Roadmap](ROADMAP.zh-CN.md)*

**可自定义参数的 LLM 本地反向代理。** 零依赖，`npx` 即可运行。

它坐在你的客户端和上游 API 之间，自动补上客户端不会发的会话头、注入任意自定义参数、
重写模型名和请求路径，然后把请求（含 SSE 流式响应）原样转发出去。

最初是为 [OpenCode Go](https://opencode.ai/docs/go/) 写的，但设计上不绑定任何一家上游——
换掉 `upstream` 和 `inject.headers` 就能服务任意 OpenAI / Anthropic 兼容接口。

---

## 解决什么问题

OpenCode Go / Zen API 要求每个请求带上会话标识：

```
x-opencode-session : 会话 ID，同一对话内保持稳定（用于提示词缓存与路由优化）
```

客户端不带这个头时，上游直接返回：

```
400 Request is missing x-opencode-session and cannot be routed efficiently
```

而大多数客户端（Trae、部分版本的 Codex、各类自建 Agent）没法自定义请求头。
本工具把这件事挪到本机完成：客户端只管把 Base URL 指向本地代理，剩下的事代理来办。

### 相关客户端的原生支持情况

如果你用的客户端**已经**原生发送会话头，就不需要本工具（但用它也无害）：

| 客户端 | 现状 | 是否需要本代理 |
| --- | --- | --- |
| OpenCode | 原生支持 | 不需要 |
| Claude Code | 上游识别其原生会话头 | 不需要 |
| Codex | 识别原生会话头，但部分版本/代理链路会丢 | 视情况，丢了就用 |
| ZCode / Pi / jcode / Kilo Code CLI | 新版本已补上 | 升级即可，旧版本可用本代理 |
| Trae / 自建 Agent / 各类 GUI 客户端 | 无法自定义请求头 | **需要** |

---

## 特性

- **自动生成会话 ID**——三级策略：客户端显式会话标识 → 内容指纹（system + 首条用户消息）→ 一次性随机。同一对话稳定复用，提示词缓存才有效。
- **任意请求头注入**——值支持模板（`{{session.id}}`、`{{uuid}}`、`{{env.HOME}}`…），想注什么注什么。
- **模型别名重写**——前缀剥离（`proxy-glm-5.3-flash` → `glm-5.3-flash`）与精确映射（`fast` → `deepseek-chat`）双管齐下。
- **请求路径重写**——客户端只会填 `/v1` 时，用一条正则把它转到上游真正要的路径。
- **请求体参数注入 / 删除**——统一给所有请求补 `temperature`、`metadata`，或删掉上游不认的字段。
- **SSE 流式零缓冲透传**——逐块转发，不攒完再发，流式体验不受影响。
- **日志默认落盘**——`~/.lsp/logs/llm-session-proxy.log`，支持按大小 / 按日期轮转与 30 天归档，进程消失也留得下线索。
- **零依赖**——只用 Node 内置模块，不引入任何第三方包，`npx` 启动无安装负担。
- **本地状态端点**——随时查看会话数、命中率、注入配置和会话明细。

---

## 安装与运行

```bash
# 免安装直接跑（推荐先这样试）
npx llm-session-proxy

# 或全局安装
npm install -g llm-session-proxy
llm-session-proxy
```

要求 Node.js >= 18。

---

## 快速开始

### 场景一：让 Trae 用上 OpenCode Go

先确认你已订阅 OpenCode Go 并拿到 API Key（[opencode.ai/auth](https://opencode.ai/auth)）。

```bash
npx llm-session-proxy
```

然后在这个客户端里新建自定义模型：

| 配置项 | 填写内容 |
| --- | --- |
| 请求地址 / Base URL | `http://127.0.0.1:9355/zen/go/v1` |
| 模型 ID | `proxy-` + 真实模型名，如 `proxy-glm-5.3-flash` |
| API Key | 你的 OpenCode API Key |

> **`proxy-` 前缀不是可选项。** Trae 按模型 ID 决定走不走自定义通道，如果填成内置预设名
> （如 `glm-5.3-flash`），流量会被 Trae 自己的云通道接走，**完全绕过本代理**，然后照样报 400。
> 加前缀强制走代理后，代理会自动把前缀剥掉再发给上游。

可用模型名见[上游文档](https://opencode.ai/docs/go/)的 Endpoints 表，例如 `glm-5.3-flash`、
`kimi-k3`、`deepseek-flash`、`qwen3.7-max`、`minimax-m3`。

如果你的客户端只允许把 Base URL 填成 `http://127.0.0.1:9355/v1`，加一条路径重写：

```bash
npx llm-session-proxy --path-rewrite "^/v1/=>/zen/go/v1/"
```

### OpenCode Go 常见模型速查表

完整可直接用的配置见 [`examples/opencode-go-models.json`](examples/opencode-go-models.json)——
它预置了下面所有别名的 `model.map`，启动即可用。

上游把模型分在三类端点上，**能不能用取决于你的客户端发什么协议**，这点比模型名更关键：

**① `/zen/go/v1/chat/completions`——OpenAI 兼容，绝大多数客户端走这条**

| 模型 | 客户端模型 ID | 上游真实 ID |
| --- | --- | --- |
| GLM-5.3 | `proxy-glm` / `proxy-glm-5.3` | `glm-5.3` |
| GLM-5.3-Flash | `proxy-glm-flash` | `glm-5.3-flash` |
| GLM-5.2 | `proxy-glm-5.2` | `glm-5.2` |
| GLM-5.1 | `proxy-glm-5.1` | `glm-5.1` |
| Kimi K3 | `proxy-kimi` | `kimi-k3` |
| Kimi K2.7 Code | `proxy-kimi-code` | `kimi-k2.7-code` |
| Kimi K2.6 | `proxy-kimi-k2.6` | `kimi-k2.6` |
| DeepSeek V4.1 Flash | `proxy-deepseek` | `deepseek-flash` |
| DeepSeek V4 Pro | `proxy-deepseek-pro` | `deepseek-v4-pro` |
| DeepSeek V4 Flash | `proxy-deepseek-v4-flash` | `deepseek-v4-flash` |
| DeepSeek V4 Flash Vision Exp | `proxy-deepseek-vision` | `deepseek-v4-flash-vision-exp` |
| LongCat-2.0 | `proxy-longcat` | `longcat-2.0` |
| MiMo-V2.5 | `proxy-mimo` | `mimo-v2.5` |
| MiMo-V2.5-Pro | `proxy-mimo-pro` | `mimo-v2.5-pro` |
| Hy3 | `proxy-hy3` | `hy3` |
| Hy4 preview | `proxy-hy4` | `hy4-preview` |

**② `/zen/go/v1/responses`——OpenAI Responses API，客户端必须支持该协议**

| 模型 | 客户端模型 ID | 上游真实 ID |
| --- | --- | --- |
| Grok 4.6 | `proxy-grok` | `grok-4.6` |
| GPT 5.6 Luna | `proxy-gpt-luna` | `gpt-5.6-luna` |
| Muse Spark 1.3 Contributor | `proxy-muse-1.3` | `muse-spark-1.3-contributor` |
| Muse Spark 1.2 Contributor | `proxy-muse-1.2` | `muse-spark-1.2-contributor` |

**③ `/zen/go/v1/messages`——Anthropic Messages API，客户端必须能发 Anthropic 格式**

| 模型 | 客户端模型 ID | 上游真实 ID |
| --- | --- | --- |
| MiniMax M3 | `proxy-minimax` | `minimax-m3` |
| MiniMax M2.7 | `proxy-minimax-2.7` | `minimax-m2.7` |
| MiniMax M2.5 | `proxy-minimax-2.5` | `minimax-m2.5` |
| Qwen3.8 Max | `proxy-qwen-max` | `qwen3.8-max` |
| Qwen3.8 Flash | `proxy-qwen-flash` | `qwen3.8-flash` |
| Qwen3.7 Max | `proxy-qwen3.7-max` | `qwen3.7-max` |
| Qwen3.7 Plus | `proxy-qwen3.7-plus` | `qwen3.7-plus` |
| Qwen3.6 Plus | `proxy-qwen-plus` | `qwen3.6-plus` |

> 本代理**不做协议转换**。客户端发 OpenAI 格式的请求体时，②③ 两类模型用不了——
> 它只负责补头、改名、换路径，不会把 Chat Completions 的 body 翻译成 Messages 的 body。
>
> 直接写上游真实 ID（不加别名、不加前缀）也能用，代理会原样放行。
> 模型清单随时可能变，以[上游文档](https://opencode.ai/docs/go/)和 `https://opencode.ai/zen/go/v1/models` 为准。

### 场景二：接任意 OpenAI 兼容上游

```bash
npx llm-session-proxy \
  --upstream https://api.deepseek.com \
  --port 8788 \
  --inject "x-session-id={{session.id}}" \
  --inject "x-trace-id={{uuid}}" \
  --inject "x-client-version=2026-01-01" \
  --model-map fast=deepseek-chat \
  --model-map smart=deepseek-reasoner \
  --model-prefix ""
```

客户端 Base URL 填 `http://127.0.0.1:8788/v1`，模型名可以用 `fast` / `smart` 这种短别名，
代理会翻译成真实模型名。完整版本见 [`examples/generic-openai.json`](examples/generic-openai.json)。

### 场景三：用配置文件（推荐长期使用）

```bash
npx llm-session-proxy --init            # 生成带注释的示例配置
npx llm-session-proxy -c llm-session-proxy.config.json
```

配置文件是有注释的 JSON（支持 `//`、`/* */` 和尾随逗号），可以按需增删字段：

```jsonc
{
  "listen": { "host": "127.0.0.1", "port": 9355 },
  "upstream": { "host": "opencode.ai" },
  "inject": {
    "headers": {
      "x-opencode-session": "{{session.id}}",
      "x-opencode-request": "{{session.requestId}}"
    }
  },
  "model": { "stripPrefixes": ["proxy-"] }
}
```

现成配置：[`examples/opencode-go.json`](examples/opencode-go.json)、
[`examples/generic-openai.json`](examples/generic-openai.json)。

---

## 配置详解

配置优先级：**默认值 < 配置文件 < 环境变量 < 命令行参数**。

### `listen`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址。只监听本机，不要改成 `0.0.0.0`，否则同网段都能用你的 Key 和额度 |
| `port` | `9355` | 监听端口 |

### `upstream`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `protocol` | `https` | `https` 或 `http` |
| `host` | `opencode.ai` | 上游主机名。也可以直接写完整 URL，代理会自动拆解 |
| `port` | `null` | 端口，`null` 表示按协议取默认值（443 / 80） |
| `basePath` | `""` | 转发时统一加在路径前面的前缀，如 `/zen/go/v1` |
| `rewriteHost` | `true` | 是否把 `Host` 头改写成上游主机 |

### `request`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `bufferBody` | `true` | 需要改写请求体（模型名、参数注入）时必须为 `true` |
| `maxBodyBytes` | `67108864` | 请求体上限（64MB），超限返回 413 |
| `timeoutMs` | `600000` | 上游请求超时 |
| `pathRewrite` | `[]` | 路径重写规则，每项 `{ "pattern": "正则", "replacement": "替换" }` |
| `dropHeaders` | `[]` | 这些请求头不转发给上游（小写） |
| `forwardClientSessionHeaders` | `true` | 是否把客户端原有的会话头一起转发 |

### `session`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用会话 ID 注入 |
| `headerNames` | `x-opencode-session` 等 5 个 | 按顺序尝试从这些**请求头**读取客户端自带会话 ID |
| `bodyFields` | `session_id` 等 | 按顺序尝试从这些**请求体字段**读取（支持点路径） |
| `contentHash.enabled` | `true` | 客户端没带会话标识时，是否用内容指纹兜底 |
| `contentHash.fields` | `["system","system_instruction","instructions"]` | 参与指纹计算的字段 |
| `contentHash.includeFirstUserMessage` | `true` | 首条 user 消息是否参与指纹 |
| `idPrefix` | `ses_` | 生成 ID 的前缀（置空则无前缀） |
| `idFormat` | `hex26` | `hex26` / `hex` / `uuid` / `base36` / `short` |
| `requestIdFormat` | `msg_{{session.count}}` | 请求号模板，`session.count` 是同一会话内的递增序号 |
| `maxSessions` | `512` | 会话表上限，超出淘汰最旧的 |
| `ttlSeconds` | `0` | 会话过期秒数，`0` 表示不过期 |

### `inject`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `headers` | 4 个 `x-opencode-*` | 要注入的请求头，值是模板字符串。设为 `null` 可跳过某项 |
| `body` | `{}` | 要合并进请求体的字段（支持嵌套对象与模板） |
| `removeBodyFields` | `[]` | 要从请求体里删掉的字段路径 |
| `overwrite` | `true` | `false` 表示客户端已有的同名头/字段不覆盖 |

### `model`

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用模型名重写 |
| `field` | `model` | 模型名所在的请求体字段 |
| `stripPrefixes` | `["proxy-"]` | 需要剥离的前缀列表，按顺序匹配，命中一个即停 |
| `map` | `{}` | 精确映射。先按客户端原始名查（优先），未命中则剥掉前缀后再查一次，所以 `proxy-glm` 与 `glm` 都能命中同一条 |
| `default` | `null` | 兜底模型名 |

### 其他

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `userAgent` | `opencode/1.18.29 cli` | 注入的 UA |
| `userAgentMode` | `replace-generic` | `keep` 保留客户端 UA；`replace` 总是替换；`replace-generic` 仅在客户端 UA 缺失或像个通用 HTTP 库时替换 |
| `response.stream` | `true` | 是否流式透传。`false` 会整体缓冲后返回（**会破坏 SSE，除非有特殊需要否则别关**） |
| `log.level` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `log.file` | `null` | `null` 表示写在默认位置（见「日志」一节）：`~/.lsp/logs/llm-session-proxy.log`；给路径就写在那儿；`false` 关闭文件输出（只出控制台） |
| `log.dir` | `null` | 只换目录，文件名保持默认 |
| `log.rotate` | `size` | `size` / `daily` / `off` |
| `log.maxBytes` | `5242880` | 单个文件超过该字节数就轮转（`size` 与 `daily` 都生效） |
| `log.backups` | `2` | 保留几份 `.1`/`.2` 备份。`0` 表示直接丢弃旧内容 |
| `log.keepDays` | `30` | 自动删除超过 N 天的历史日志。`0` 表示永久保留 |
| `lang` | `en` | 控制台与日志文案语言：`en` / `zh` |

---

## 日志

**默认就会写日志文件**，因为最难查的故障——未捕获异常、进程悄无声息地消失——恰恰是终端窗口一关
就什么线索都不剩的那类。

| 想做什么 | 怎么做 |
| --- | --- |
| 默认位置 | `$LSP_HOME/logs/llm-session-proxy.log`；未设置 `LSP_HOME` 时是 `~/.lsp/logs/llm-session-proxy.log` |
| 指定文件 | `log.file` / `--log-file <path>` / `LOG_FILE=<path>` |
| 只换目录 | `log.dir` / `--log-dir <dir>` / `LOG_DIR=<dir>`（文件名保持默认） |
| 关掉 | `--no-log-file` / `"file": false` / `LOG_FILE=off` |

轮转方式由 `log.rotate` / `--log-rotate` / `LOG_ROTATE` 决定：

| 模式 | 行为 |
| --- | --- |
| `size`（默认） | `app.log` 涨到 `log.maxBytes` 后变成 `app.log.1`、`.2` …，最多保留 `log.backups` 份 |
| `daily` | 每天一个文件：`app-YYYY-MM-DD.log`；`log.maxBytes` 依然限制单日文件大小 |
| `off` | 不轮转也不截断，交给 `logrotate` 之类的外部工具 |

**归档。** 启动时、以及运行期间最多每 6 小时一次，日志器会删除**符合自己命名规则**
（`app.log`、`app.log.N`、`app-YYYY-MM-DD.log`）且 mtime 早于 `log.keepDays`（默认 **30**，
`0` 为永久保留）的文件。正在写的文件永不删除；不符合命名规则的文件（包括同目录里其他任何文件）
一律不动。

想确认日志实际落在哪儿：

```bash
llm-session-proxy --print-config | grep resolvedFile
```

依赖默认位置时 `log.file` 仍是 `null`；`--print-config` 输出里的 `log.resolvedFile` 才是日志器
真正会打开的那个绝对路径。

---

## 模板变量

`inject.headers` 和 `inject.body` 的值都是模板，可用变量如下：

| 变量 | 含义 |
| --- | --- |
| `{{session.id}}` | 本次请求使用的会话 ID |
| `{{session.count}}` | 该会话内的第几个请求（从 1 开始） |
| `{{session.requestId}}` | 按 `requestIdFormat` 渲染出的请求号，如 `msg_3` |
| `{{session.source}}` | 会话来源：`header:*` / `body:*` / `content-hash` / `random` |
| `{{model}}` | 重写后的模型名 |
| `{{path}}` / `{{method}}` | 原始请求路径 / 方法 |
| `{{header.x-foo}}` | 客户端请求头（小写） |
| `{{query.foo}}` | 查询参数 |
| `{{env.HOME}}` | 环境变量 |
| `{{uuid}}` | 每次渲染都不同的 UUID |
| `{{random}}` / `{{randomHex:16}}` | 随机十六进制串，默认 26 / 16 位 |
| `{{timestamp}}` / `{{timestampMs}}` | 秒 / 毫秒时间戳 |

---

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `-c, --config <file>` | 读取配置文件 |
| `-p, --port <n>` / `--host <addr>` | 监听端口 / 地址 |
| `-u, --upstream <url>` | 上游地址，如 `https://opencode.ai` 或 `host:port` |
| `--base-path <path>` | 转发路径前缀 |
| `--path-rewrite <a=>b>` | 路径重写，可重复 |
| `--inject <name=value>` | 注入请求头，可重复 |
| `--body-inject <k=v>` | 注入请求体字段，可重复 |
| `--model-prefix <prefix>` | 要剥离的模型名前缀，可重复 |
| `--model-map <a=b>` | 模型名精确映射，可重复 |
| `--session-header <name>` | 追加会话来源请求头，可重复 |
| `--session-field <path>` | 追加会话来源请求体字段，可重复 |
| `--session-id-format <f>` | 会话 ID 格式 |
| `--request-id-format <t>` | 请求号模板 |
| `--no-session` | 关闭会话注入 |
| `--no-stream` | 关闭流式透传 |
| `--timeout <ms>` / `--max-body <bytes>` | 超时 / 请求体上限 |
| `--log-level <l>` | 日志级别 |
| `--log-file <f>` / `--no-log-file` | 日志文件路径 / 关闭文件输出 |
| `--log-dir <dir>` | 默认日志文件所在目录 |
| `--log-rotate <mode>` | `size` / `daily` / `off` |
| `--log-keep-days <n>` | 自动删除超过 N 天的历史日志（`0` 为永久保留） |
| `-l, --lang <en\|zh>` | 控制台与日志文案语言（默认 `en`）|
| `--init [file]` | 生成示例配置 |
| `--print-config` | 打印合并后的最终配置并退出 |

环境变量与配置文件同名字段一一对应（大写形式）：`PROXY_PORT`、`UPSTREAM_HOST`、
`UPSTREAM_PROTO`、`OPENCODE_UA`、`LOG_LEVEL`、`LOG_FILE`、`LOG_DIR`、`LOG_ROTATE`、
`LOG_KEEP_DAYS`、`MODEL_ALIAS_PREFIX`、`INJECT_HEADERS`（JSON）等。

---

## 本地状态端点

只监听本机，不会转发到上游：

```bash
# 运行概览：会话数、命中率、注入的头、上游地址
curl http://127.0.0.1:9355/__llm_session_proxy__/status

# 会话明细：每个会话的 ID、请求数、最后使用时间
curl http://127.0.0.1:9355/__llm_session_proxy__/sessions
```

排错时很有用——如果 `sessions.active` 一直是 0，说明请求根本没到代理（多半是模型 ID 没加 `proxy-` 前缀）。

---

## 工作原理

```
客户端 ──▶ llm-session-proxy ──▶ 上游 API
              │
              ├─ 1. 读请求体，解析 JSON
              ├─ 2. 解析会话：显式标识 > 内容指纹 > 随机
              ├─ 3. 重写路径、模型名
              ├─ 4. 注入请求头与请求体参数
              └─ 5. 转发，SSE 逐块回传
```

会话识别的三级策略是关键，它决定了会话 ID 能不能在同一对话内保持稳定：

1. **显式标识**——客户端自己发了 `x-opencode-session` 之类的头，或请求体里有 `session_id`。直接复用，最准。
2. **内容指纹**——对 `system` + 首条 user 消息做 SHA-256。同一对话的后续轮次只是往后追加消息，首条不变，所以指纹稳定，能落回同一个 ID。
3. **一次性随机**——两者都没有时（比如请求体不是 JSON），发一个随机 ID，只保证上游不报 400；这类请求不进会话表，避免把表撑爆。

---

## 作为库使用

```js
import { startProxy, buildConfig, createProxyServer } from 'llm-session-proxy';

const proxy = await startProxy({
  flags: {
    listen: { port: 9355 },
    upstream: { host: 'opencode.ai' },
    inject: { headers: { 'x-opencode-session': '{{session.id}}' } },
  },
});

console.log(`代理已启动: ${proxy.url}`);
console.log(`运行中会话: ${proxy.store.size}`);

// 退出时
await proxy.stop();
```

也可以只取零件：`createProxyServer`（自己控制生命周期）、`SessionStore`（会话表）、
`renderTemplate`（模板引擎）、`buildConfig`（配置合并）。

---

## 稳定性

- **单个畸形请求不会让进程退出。** 代理拦截了请求处理路径上所有同步抛出：非法的 `Host` 头、
  畸形请求行、上游返回含非法字符的状态行或响应头，都会被转成对应的 4xx / 5xx 响应，进程继续服务。
- **未捕获异常会写进日志文件。** 兜底处理器把 `uncaughtException` 与 `unhandledRejection`
  的完整栈写进日志文件（同时输出到 stderr）；Node 默认只打 stderr 然后直接终止进程，
  日志文件里一个字都不会有，现场看起来就是「日志一切正常，进程凭空消失」。
  正因如此，**文件日志默认就是开着的**——不特别指定就写在 `~/.lsp/logs/llm-session-proxy.log`。
- 60 秒内连续出现 20 次未捕获错误会判定为持续故障并主动退出，避免带着坏状态空转。

---

## 常见问题

**客户端报连接失败 / 代理日志里没有请求记录**

检查 Base URL 是否指向了本代理，以及模型 ID 是否加了 `proxy-` 前缀。后者是最常见的原因——
Trae 之类客户端会按模型 ID 把流量分流到自己的云通道。

**还是 400，说缺 session 头**

看代理日志里那次请求的 `session=` 字段。如果有值，说明代理注入了但上游没收到，
多半是 `inject.headers` 被配置文件覆盖掉了；如果没有值，说明 `session.enabled` 被关了。

**对话越长越慢，提示词缓存没生效**

说明会话 ID 不稳定。检查客户端是否每轮都在改变 `system` 或首条 user 消息的内容
（某些客户端会把时间戳、当前文件路径塞进 system）。可以改用显式会话头，
或把 `contentHash.fields` 收窄到最稳定的那个字段。

**想代理到别的上游，注入头会冲突吗**

不会。默认注入的头对不认它们的上游来说是无害的多余头。要干净的话，
把 `inject.headers` 改成空对象 `{}`，或只留你需要的那几个。

**端口被占用**

`EADDRINUSE` 时换端口：`--port 9356`，同时记得改客户端里的 Base URL。

---

## 限制与注意

- **只监听本机（127.0.0.1）**——代理会带上你的 API Key 转发请求，不要把监听地址改成 `0.0.0.0`。
- **`response.stream: false` 会破坏 SSE**——除非确实需要整体缓冲，否则保持 `true`。
- **`bufferBody: false` 时无法改写请求体**——模型重写和参数注入会失效，只能注入请求头、也只能靠请求头识别会话。
- 本工具只做转发与参数修补，不缓存、不计费、不修改响应内容。

---

## English

**llm-session-proxy** is a dependency-free local reverse proxy for LLM APIs. It injects the
session headers your client won't send (`x-opencode-session` and friends), rewrites model
aliases and request paths, injects arbitrary custom parameters, and streams SSE responses
through untouched.

```bash
npx llm-session-proxy                       # default: OpenCode Go on 127.0.0.1:9355
npx llm-session-proxy -u https://api.example.com --inject "x-session-id={{session.id}}"
```

Point your client's base URL at `http://127.0.0.1:9355/zen/go/v1` and use `proxy-<model-id>`
as the model name. See the Chinese sections above for the full configuration reference.

## 发布新版本

发布由 GitHub Actions 完成（[`.github/workflows/publish.yml`](.github/workflows/publish.yml)），不需要在本机登录 npm：

1. 改 `package.json` 里的 `version`
2. 提交并推送
3. 打一个同名 tag 并推送：

```bash
git tag v0.1.2 && git push origin v0.1.2
```

workflow 会先跑完全部单元测试、校验 tag 与 `package.json` 版本一致，再用仓库 secrets 里的
`NPM_TOKEN` 发布到 registry.npmjs.org。也可以在 Actions 页面手动触发，勾选 dry run 只做干跑。

## Roadmap

这个项目刻意保持窄：**零依赖、本地、单进程**，`npx` 直接起。路线图上的每一项都必须符合这个形状。

- **v0.2 — 协议转换与路由。** Anthropic ↔ OpenAI ↔ Responses 互转、按请求规则路由、上游兜底。
  这是唯一能让一个客户端吃满所有模型类的功能——否则它只能用自己那套协议支持的端点。
- **v0.3 — 可观测与可控。** Prometheus 格式指标、结构化 JSON 日志、token/成本统计端点、
  免构建的本地看板。
- **v0.4 — 真实上游下的可靠性。** 熔断、上游健康检查、带抖动的重试、流空闲看门狗、优雅退出。
- **v1.0 — 加固与分发。** 配置 schema 校验、按客户端的兼容性矩阵、随仓库的基准测试工具、
  单文件可执行产物。

完整的取舍、与同类网关（LiteLLM、claude-code-router、one-api、Portkey、Bifrost、Envoy AI Gateway）的功能对照、可量化的性能目标与明确的非目标，见 [ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)。

## License

[Apache License 2.0](LICENSE) © 2026 alaahong
