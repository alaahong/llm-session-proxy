# llm-session-proxy

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
| `map` | `{}` | 精确映射，**优先于**前缀剥离 |
| `default` | `null` | 兜底模型名 |

### 其他

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `userAgent` | `opencode/1.18.29 cli` | 注入的 UA |
| `userAgentMode` | `replace-generic` | `keep` 保留客户端 UA；`replace` 总是替换；`replace-generic` 仅在客户端 UA 缺失或像个通用 HTTP 库时替换 |
| `response.stream` | `true` | 是否流式透传。`false` 会整体缓冲后返回（**会破坏 SSE，除非有特殊需要否则别关**） |
| `log.level` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `log.file` | `null` | 额外的日志文件路径，按大小自动轮转 |

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
| `--log-level <l>` / `--log-file <f>` | 日志级别 / 日志文件 |
| `--init [file]` | 生成示例配置 |
| `--print-config` | 打印合并后的最终配置并退出 |

环境变量与配置文件同名字段一一对应（大写形式）：`PROXY_PORT`、`UPSTREAM_HOST`、
`UPSTREAM_PROTO`、`OPENCODE_UA`、`LOG_LEVEL`、`LOG_FILE`、`MODEL_ALIAS_PREFIX`、
`INJECT_HEADERS`（JSON）等。

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

## License

[MIT](LICENSE)
