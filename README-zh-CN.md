# llm-session-proxy

[![npm version](https://img.shields.io/npm/v/llm-session-proxy.svg)](https://www.npmjs.com/package/llm-session-proxy)
[![Publish to npm](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml/badge.svg)](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-1f6feb)](https://www.ianzhang.cn/llm-session-proxy/zh/)

*中文 · [English](README.md) · [在线文档](https://www.ianzhang.cn/llm-session-proxy/zh/) · [Roadmap](ROADMAP.zh-CN.md)*

> 说明：本文件刻意命名为 `README-zh-CN.md`（连字符而非点号）。npm 生成包页面 readme 时会按 glob
> `{README,README.*}` 取**第一个**匹配文件，实测 `README.zh-CN.md` 会排在 `README.md` 之前，
> 导致 npm 页面展示中文版；连字符写法不匹配该 glob，保证 npm 页面默认展示英文 README。

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
- **模型别名重写**——前缀剥离（`proxy-glm-5.3-flash` → `glm-5.3-flash`）与精确映射（`fast` → `deepseek-chat`）双管齐下。**内置了 OpenCode Go 的别名表**，文档里让你写的 `proxy-` 前缀开箱就能解析；万一某个别名剥完前缀查不到映射，代理会明确告诉你该补哪一条，而不是悄悄把一个不存在的模型名发给上游。
- **按规则分桶路由**——`default` / `background` / `think` / `longContext` 四个桶，各自可以换模型、挂变换。规则按路径前缀、模型前缀、请求体字段、请求体大小、**请求难度**匹配，**自上而下、首个命中即止**，同一条规则内的条件是与关系。默认关闭，升级不会改变现有行为。
- **难度打分**——一个本地确定性打分器按请求的**形态**（体积、对话轮数、代码块、diff 行数、工具数量、涉及文件、推理意图）打分，再映射到具名档位（`easy` / `medium` / `hard`）。规则于是可以写 `{ "bucket": "think", "difficulty": "hard" }`，不用再手调字节阈值。它衡量的是请求**形态**而非语义难度——见[限制与注意](#限制与注意)。
- **多上游，各自带各自的凭据**——把不同模型分流到不同上游：你自己的 API key、GitHub Copilot 订阅、本地 Ollama，可以并存。每个上游自己声明端点路径、线协议与凭据来源。**凭据在运行时现取，绝不写进配置文件。**
- **可组合的请求体变换**——五个内置命名变换（`drop-fields`、`drop-empty-fields`、`rename-fields`、`clamp-max-tokens`、`noop`），可以全局挂，也可以按桶挂，按固定顺序执行。注册表是**写死的清单**：**代理绝不会从某个路径加载代码**，「零依赖 + 只听回环」这句话才站得住。
- **协议互转**——让只会说一种协议的客户端调到说另一种协议的模型：OpenAI Chat Completions ↔ Anthropic Messages ↔ OpenAI Responses ↔ Google Gemini，请求体与响应体都转，SSE 流按事件逐条转码、流式体验不降级。默认关闭；按模型前缀路由，语义与路由分桶同款。
- **请求路径重写**——客户端只会填 `/v1` 时，用一条正则把它转到上游真正要的路径。
- **请求体参数注入 / 删除**——统一给所有请求补 `temperature`、`metadata`，或删掉上游不认的字段。
- **SSE 流式零缓冲透传**——逐块转发，不攒完再发，流式体验不受影响。
- **日志默认落盘**——`~/.lsp/logs/llm-session-proxy.log`，支持按大小 / 按日期轮转与 30 天归档，进程消失也留得下线索。
- **启动前体检**——`--dry-run` 打印一次请求会怎么被路由、注入了哪些头、模型名解析成什么，全程不发任何请求；`--doctor` 再加上 DNS/TCP/TLS 可达性、监听端口与真实的 Copilot 凭据检查，有问题时退出码非 0。
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

完整可直接用的配置见 [`examples/opencode-go-models.json`](examples/opencode-go-models.json)。

下面表格里的**客户端模型 ID 全部开箱即用**——这些别名已经内置在 `model.map` 里（见 `src/models.js`），
不加 `-c` 配置文件也能生效。想知道某个别名最终会变成什么，跑
`--dry-run --model proxy-glm` 即可。

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

> 本代理**默认不做协议转换**。它默认只负责补头、改名、换路径，不会把 Chat Completions 的
> body 翻译成 Messages 的 body。协议互转（以及 Gemini 协议）在 v0.2.2 / v0.3.0 交付了，
> 见 [`protocol`](#protocol) 与 [Roadmap](ROADMAP.zh-CN.md)。
>
> 直接写上游真实 ID（不加别名、不加前缀）也能用，代理会原样放行。
> 模型清单随时可能变，以[上游文档](https://opencode.ai/docs/go/)和 `https://opencode.ai/zen/go/v1/models` 为准。
> 换到别的上游时，内置别名对不上它的模型名——请你提供自己的 `model.map`，
> 并留意下面提到的「别名未命中」告警。

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
| `port` | `9355` | 监听端口。填 `0` 表示让系统随机分配。避开 [WHATWG 禁用端口](#禁用监听端口)——浏览器和 `fetch` 客户端会按规范拒绝连接 |

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
| `map` | 内置 27 条别名 | 别名 → 上游真实模型 ID。与内置表**逐键深合并**：同名键以你的为准，其余保留。内置项删不掉，想改就覆盖同名的键 |
| `default` | `null` | 兜底模型名。只在「名字完全没被动过、也什么都没命中」时生效；`proxy-xxx` 被剥成 `xxx` 后查不到映射的情况**不兜底** |
| `warnUnmapped` | `true` | 别名剥完前缀既无映射也无 `default` 时，每个别名告警一次 |

客户端送来的模型名，解析顺序是：

1. 先按**原始名**查 `map`——命中即定，不再剥前缀。
2. 否则剥掉第一个命中的 `stripPrefixes`，再拿剥完的名字查一次 `map`。所以 `proxy-glm` 和 `glm` 都能命中同一条。
3. 名字没被动过且什么都没命中时，用 `default`。
4. 其余情况原样转发。

第 4 步就是「模型不存在」报错的来源：客户端送 `proxy-<某个不在表里的名字>`，前缀被剥掉，剩下的原样发给上游。
除非它恰好是个真实 ID，否则上游会直接拒绝。现在代理会明确告诉你缺哪一条：

```
[model] 别名 "proxy-mystery" 剥掉前缀 "proxy-" 后没有命中任何映射 —— 会把 "mystery" 原样发给上游。
        请补 model.map["mystery"]，或让客户端直接填真实模型 ID。
```

每个别名在一个进程里最多喊一次，客户端狂发也不会把日志刷爆；`"warnUnmapped": false` 可关掉。
不带前缀的名字永远不告警——直接填真实 ID 是正常用法，不该吵。

### `transformers`

对**所有**请求生效的请求体变换，与 router 开关无关。只能写名字：注册表是编译进代理里的固定清单，配置文件无法让它执行任意代码。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `[]` | 变换名列表，**从左到右**依次执行 |
| `options` | `{}` | 每个变换各自的参数，按变换名索引 |

| 名称 | 参数 | 作用 |
| --- | --- | --- |
| `noop` | — | 什么都不做。适合用来确认注册表确实接上了 |
| `drop-fields` | `fields: ["a.b"]` | 删除列出的点路径 |
| `drop-empty-fields` | `fields?: [...]` | 删除值为 `null`、`""`、`[]`、`{}` 的字段。`0` 和 `false` 会保留。不给 `fields` 时逐个检查顶层键 |
| `rename-fields` | `map: { "from": "to" }` | 重命名点路径，父对象不存在会自动创建。映射到自己身上的会被忽略 |
| `clamp-max-tokens` | `max: 4096`、`fields?: [...]` | 把 `max_tokens` / `max_completion_tokens` 压到不超过 `max`；只降不升，`max` 非法时等于不做 |

顺序会影响结果，因为每个变换都是原地改请求体：`rename-fields` 放在 `drop-fields` 前面，和反过来跑，结果不一样。

```json
"transformers": {
  "enabled": ["drop-empty-fields"],
  "options": { "drop-empty-fields": { "fields": ["temperature", "top_p"] } }
}
```

名字不在上表里是**启动即报错**，不会静默忽略。

### `router`

把流量分到不同的桶。一个桶决定两件事：用哪个**模型**、挂哪些**变换**。`enabled` 默认 `false`，所以现有配置在你主动打开之前行为完全不变。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。`--no-router` 强制关闭 |
| `forced` | `null` | 所有请求都走这个桶、忽略全部规则（`--router <桶名>`）。它的优先级高于 `enabled: false`——用户都点名了，再被配置挡掉只会让人困惑 |
| `defaultBucket` | `default` | 没命中任何规则的请求落到这个桶 |
| `buckets` | 内置四个，全为空 | `{ "model": <模型 ID 或 null>, "transformers": [<名字>] }`。可以自己加桶名；没声明过的桶名退化成空桶 |
| `rules` | `[]` | 见下 |

一条规则必须有 `bucket`，外加**至少一个**匹配条件。一个条件都不给是配置错误：无法判定的规则和「命中一切」不是一回事。

| 匹配条件 | 命中条件 |
| --- | --- |
| `path` | 请求路径**以该字符串开头**。比对的是客户端发来的路径，早于 `request.pathRewrite` |
| `modelPrefix` | **客户端原始模型名**或**重写后的模型名**任一个以它开头，所以 `proxy-think` 和 `glm-5.3` 都能拿来写规则 |
| `bodyField` | 该点路径存在且非空（`0` 和 `false` 算非空）。再加 `bodyFieldValue` 则要求等于某个具体值 |
| `minBytes` / `maxBytes` | 请求体字节数，两端都是闭区间 |
| `difficulty` | 请求的难度档位等于这个名字。**只有配了打分器才参与判定**——见下 |

规则**自上而下求值，首个命中即止**；同一条规则内多个条件是「与」，所以写的时候要从具体到宽泛。
大小一律按**字节，不按 token**：估 token 就得带一个分词器，而字节数是你能实际调得动的数字。

```json
"router": {
  "enabled": true,
  "defaultBucket": "default",
  "buckets": {
    "think":       { "model": "glm-5.3-think" },
    "longContext": { "model": "glm-5.3-long" },
    "background":  { "model": "glm-5.3-flash", "transformers": ["clamp-max-tokens"] }
  },
  "rules": [
    { "bucket": "think",       "path": "/zen/go/v1/messages" },
    { "bucket": "longContext", "minBytes": 60000 },
    { "bucket": "background",  "modelPrefix": "proxy-haiku", "maxBytes": 4096 }
  ]
}
```

桶的 `transformers` 是**追加**到全局 `transformers.enabled` 后面的：桶只能加、不能取消全局的某个变换，要取消就把它从全局列表里删掉。

桶的 `model` 在别名重写**之后**生效并直接替换结果，所以这里应当写真实的上游模型 ID、而不是 `proxy-` 别名。引用 `{{model}}` 的请求头模板看到的是桶覆盖后的值，因为注入是最后一步。

#### 难度打分

字节阈值总是别扭：40 KB 的请求可能是一个粘贴的文件，也可能是五十条短消息。**打分器**改按请求的**形态**评分，**档位**再把分数变成一个能拿来做匹配的名字。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `router.scorers.enabled` | `[]` | 要跑的打分器，按名字。内置只有 `builtin-complexity`。**留空 = 不打分，此时 `difficulty` 规则永远不命中** |
| `router.bands` | `easy` ≤ 30、`medium` ≤ 60、`hard` ≤ 100 | 档位定义，加载时按 `maxScore` 排序。一个档位形如 `{ "name": "easy", "maxScore": 30 }` |

`builtin-complexity` 看九个信号，每个先归一化到 0–1 再乘权重（权重合计 100）：

| 信号 | 权重 | 衡量什么 |
| --- | --- | --- |
| `bytes` | 22 | 请求体大小，走**对数**刻度（`log2(len+1)/16`）。小于 512 字节一律 **0 分**——一句话不复杂 |
| `turns` | 12 | 对话里的消息条数 |
| `codeBlocks` | 15 | 消息文本里的围栏代码块数 |
| `diffLines` | 13 | 以 `+` / `-` 开头的行数（排除 `+++` / `---` 文件头） |
| `tools` | 8 | 工具声明的数量 |
| `system` | 8 | system 提示词的体积 |
| `files` | 8 | 涉及的不同文件路径（按扩展名识别） |
| `reasoning` | 8 | 明确的推理意图（`reasoning_effort`、`thinking` 等） |
| `maxTokens` | 6 | 要求的输出预算 |

```json
"router": {
  "enabled": true,
  "scorers": { "enabled": ["builtin-complexity"] },
  "bands": [
    { "name": "easy",   "maxScore": 30 },
    { "name": "medium", "maxScore": 60 },
    { "name": "hard",   "maxScore": 100 }
  ],
  "buckets": {
    "cheap": { "model": "glm-5.3-flash" },
    "smart": { "model": "glm-5.3-think" }
  },
  "rules": [
    { "bucket": "smart", "difficulty": "hard" },
    { "bucket": "cheap", "difficulty": "easy" }
  ]
}
```

打分器是**本地且确定性**的——同一个请求，每次、每台机器都是同一个分数。没有模型调用、没有网络、没有随机。它同样是**树内具名注册表**（与变换同款）：配置文件不能让它去加载代码。

> **它测不了什么。** 打分器评的是请求**形态**，不是语义难度。一句「把这个函数改成幂等的」分数很低；一条 30 个字、内容相同的消息分数也一样低。请把它当作**廉价且可解释的启发式**——而你明确知道情况时，还是用 `minBytes` / `maxBytes` / `modelPrefix`。

### `upstreams`

上游池。顶层那个 `upstream`（单个上游）照旧能用；池子**默认为空**，所以现有配置行为不变。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 池子的总开关 |
| `providers` | `{}` | 具名上游，每个声明自己的类型、base URL、端点路径、线协议与凭据来源 |
| `routes` | `[]` | `{ "model": <前缀>, "upstream": <上游名> }`。自上而下，首个命中即止 |
| `default` | `null` | 没有规则命中时用的上游 |

选上游的顺序：**桶里指定的 `upstream`**（路由选中桶时）→ **按模型前缀命中的 `routes` 条目** → **`default`**。都没命中就回落到顶层 `upstream`。

模型前缀会同时比对**客户端发来的名字**与**别名重写后的名字**，所以 `proxy-gpt-5` 和 `gpt-5` 都能用。

一个上游长这样：

```json
"upstreams": {
  "enabled": true,
  "providers": {
    "own": {
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "env": "OPENAI_API_KEY" }
    },
    "copilot": {
      "type": "copilot",
      "baseUrl": "https://api.githubcopilot.com"
    },
    "local": {
      "type": "openai",
      "baseUrl": "http://127.0.0.1:11434/v1"
    }
  },
  "routes": [
    { "model": "gpt-5",  "upstream": "copilot" },
    { "model": "claude", "upstream": "own" }
  ],
  "default": "own"
}
```

| 上游字段 | 说明 |
| --- | --- |
| `type` | `openai` / `anthropic` / `gemini` / `copilot` / `custom`。决定默认端点路径、默认线协议与默认凭据头 |
| `baseUrl` | 发到哪里。路径部分成为 base path，主机名成为连接目标 |
| `paths` | 每种线协议对应的端点路径，例如 `{ "chat": "/chat/completions" }`。`{model}` 与 `{stream}` 会被替换 |
| `wire` | 这个上游说哪几种协议。按类型取默认值 |
| `modelWire` | 按模型前缀覆盖协议，例如 `{ "gpt-5": "responses" }`。前缀长的优先 |
| `headers` | 静态请求头（不含凭据） |
| `auth.env` | 存放 API key 的环境变量，多个用逗号分隔构成兜底链 |
| `auth.command` | 一条命令，它的 **stdout** 就是 API key。用 `execFile` 执行，不经过 shell |
| `auth.header` / `auth.prefix` | 覆盖凭据头的名字与前缀 |
| `auth.allowCommand` | `false` 表示不许执行任何命令去取凭据 |
| `auth.tokenMode` | 仅 Copilot：`direct`（默认，GitHub token 直接当 Bearer 发）或 `session`（先换一个约 30 分钟的 session token） |
| `auth.deviceFlow` | 仅 Copilot：`true` 时允许把 OAuth 设备流作为最后一环凭据来源（需要人参与，默认关闭） |

**凭据绝不从配置文件读，也绝不进日志。** 配置只说 key **从哪来**；值在请求时现取，直接装进请求头。`--doctor` 里只会显示**来源名**（`env:OPENAI_API_KEY`），看不到 key 本身。

默认凭据头按类型给：OpenAI 兼容走 `Authorization: Bearer …`，Gemini 走 `x-goog-api-key`，Anthropic 走 `x-api-key`。

#### 把 GitHub Copilot 当成一个上游

`copilot` 类型的上游**直接把 GitHub token 发给** `api.githubcopilot.com`——与官方 Copilot SDK、
OpenCode、OMP 的做法一致：

```
GitHub token  →  Authorization: Bearer <token>  →  api.githubcopilot.com
```

GitHub token 的查找顺序与官方 Copilot SDK 一致：

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `GITHUB_TOKEN`
4. `gh` CLI（`gh auth token`）——`auth.allowCommand` 为 `false` 时跳过
5. 凭据文件 `~/.lsp/copilot-credentials.json`（权限 `0600`）——上一次设备流登录的存档
6. **设备流登录**——且仅当上游写了 `"auth": { "deviceFlow": true }`

上游可以用 `auth.env` 指定变量名、用 `auth.command` 指定命令，覆盖前几环。

跑一次设备流登录，token 就会存进凭据文件，之后既不需要环境变量、也不需要已登录的 `gh`：

```bash
npx llm-session-proxy --login-copilot
```

如果环境里已经设了凭据变量，CLI 会明确提示：环境变量优先于存档文件。

`auth.tokenMode` 决定 token 怎么用：

- `direct`（默认）——GitHub token 原样装进 `Authorization: Bearer`。GitHub 现在接受
  `gho_`、`ghu_` 与 `github_pat_` 直连。
- `session`——先到 `api.github.com/copilot_internal/v2/token` 换一个约 30 分钟的 session token，
  **只在内存里缓存**，到期前五分钟刷新。这是旧版流程；部分 OAuth token（尤其是
  `gh auth token`）会被该端点以 `403` 拒绝，只有确实需要短命 token 的部署才建议开启。

> **`ghp_` 不支持。** 官方 SDK 明确把 classic PAT 标为已弃用；请用带 **Copilot Requests** 权限的细粒度 PAT（`github_pat_`）或 OAuth token。

拿不到凭据时，请求以 `502` 失败并给出明确原因，而不是没带凭据就发给上游。

上游按模型选端点：`gpt-5*`、`codex*`、`o1`–`o4` 走 `/responses`，其余走 `/chat/completions`。Copilot 还需要几个固定头——`Copilot-Integration-Id: copilot-developer-cli`、`Editor-Version`、`Editor-Plugin-Version`、`User-Agent`、`X-GitHub-Api-Version: 2026-08-01`——代理会替你补齐，`headers` 可以覆盖任意一项。（`2026-08-01` 是 Copilot API 的版本；`2022-11-28` 属于 `api.github.com`，发给 `api.githubcopilot.com` 会得到 `400 invalid apiVersion`。）

`--doctor` 会对每个 `copilot` 上游做一次只读的 `GET /models`，报告凭据来源、token 模式与可见模型数；
token 本身绝不会出现在输出里。`401`/`403` 会被判为问题，并让命令以非 0 退出。

> **关于 BYOK。** Copilot 的「自带密钥」是**客户端**功能：密钥存在客户端的钥匙串里，流量直连 provider，计费归 provider，代理拦不到。代理能做的是另一半——**一部分**请求走你的 Copilot 订阅、**另一部分**走你自己的 provider 密钥，按模型决定。

### `protocol`

协议互转。代理从请求路径推断客户端说的是哪套协议（`/chat/completions` → `chat`、`/messages` → `messages`、`/responses` → `responses`、`:generateContent` → `gemini`），再由路由（或 `forced`）决定**上游**说哪套。两者不同时：请求体在转发前整体转换，响应在回到客户端前转换回来——JSON 体整包改写，SSE 流**按事件逐条**转码，流式体验不降级。`enabled` 默认 `false`。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。`--no-protocol` 强制关闭 |
| `forced` | `null` | 把所有请求强制转成该协议，忽略全部路由（`--protocol <target>`）。写了同样压过 `enabled: false` |
| `paths` | 四条 `/zen/go/v1/…` 默认路径 | 每种目标协议对应的上游路径。`paths.<target>` 会**整体替换**转发的路径（注意与 `request.pathRewrite` 的「修补客户端路径」语义不同） |
| `routes` | `[]` | `{ "model": <前缀，可选>, "target": <协议>, "path": <上游路径，可选> }`。自上而下、首个命中即止；不带 `model` 的路由匹配所有请求 |

转换时做的字段归一化：`max_tokens` ↔ `max_completion_tokens` ↔ `max_output_tokens`；`reasoning_effort` ↔ `thinking.budget_tokens`（固定表 low=1024 / medium=8192 / high=16384，反向 ≥16384 → high、≥4096 → medium、否则 low）↔ Gemini 的 `thinkingConfig.thinkingBudget`；工具声明与工具调用在各形状间重塑；`stop` ↔ `stop_sequences` ↔ `stopSequences`；chat 的 system 消息 ↔ Anthropic 的顶层 `system` ↔ Responses 的 `instructions` ↔ Gemini 的 `systemInstruction`。没有等价物的字段（`cache_control`、`response_format`…）**逐个记名丢弃**，转换本身以 `protocol:<from>-><to>` 标签进日志。

Gemini 有两点与众不同，值得单独说：它的模型名住在**路径**里（`/v1beta/models/{model}:generateContent`），不在请求体里；流式是靠**方法名**区分的（`:streamGenerateContent?alt=sse`），而不是请求体里的一个开关。上游声明 `gemini` 线协议时代理会把这两点都处理掉。

两个刻意为之的边界：Anthropic 必填 `max_tokens`，chat 请求两个名字都没带时补一个保守的 `4096`（日志记 `max_tokens:default(4096)`），而不是等上游 400；**上游 4xx/5xx 错误体永不转换**——错误是上游协议的一部分，与不走转换时一样原样回传。

```json
"protocol": {
  "enabled": true,
  "paths": {
    "chat": "/zen/go/v1/chat/completions",
    "messages": "/zen/go/v1/messages",
    "responses": "/zen/go/v1/responses"
  },
  "routes": [
    { "model": "minimax", "target": "messages" },
    { "model": "gpt", "target": "responses" }
  ]
}
```

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

## 启动前体检：`--dry-run` 与 `--doctor`

两个开关都会校验配置、把「代理到底会怎么做」打印出来，然后退出——不起服务、不建日志文件、
不向上游发任何请求。

```bash
llm-session-proxy --dry-run
```

```
llm-session-proxy v0.3.1 —— 试运行

配置
  文件            （无）
  语言            zh
  监听            127.0.0.1:9355

上游
  地址            https://opencode.ai
  Host 头         opencode.ai
  路径前缀        （无）
  改写 Host       是
  UA              opencode/1.18.29 cli（模式 replace-generic）

路由
  路径重写        （无，原样透传）
  会话来源        请求头 x-opencode-session, x-session-id, …；请求体 session_id, sessionId, …
  会话 ID         hex26 | msg_{{session.count}}

注入
  请求头          x-opencode-session = {{session.id}}  ->  ses_378f3582ae608b101b83606614
  请求头          x-opencode-request = {{session.requestId}}  ->  msg_1
  …

模型
  样例            proxy-glm
  剥离            前缀 "proxy-" -> glm
  映射            glm -> glm-5.3
  结果            glm-5.3  （命中映射）
  映射表          内置 27 条，覆盖 0 条

路由分桶
  启用            否
  默认桶          default
  打分器          （无 —— 没有打分器时「难度」规则永远不会命中）
  桶 default      （无）
  桶 background   （无）
  桶 think        （无）
  桶 longContext  （无）
  规则            （无规则）
  样例路由        default（路由已关闭）

变换
  全局            （无）
  生效            （无）
  可用            noop, drop-fields, drop-empty-fields, rename-fields, clamp-max-tokens

协议互转
  启用            否（原样透传）
  路径            chat=/zen/go/v1/chat/completions，messages=/zen/go/v1/messages，responses=/zen/go/v1/responses
  规则            （无规则）
  样例转换        样例请求不发生转换

上游池
  池子            （空 —— 只有一个上游，与之前完全一致）
  默认上游        （无）

日志
  文件            ~/.lsp/logs/llm-session-proxy.log
  轮转            按大小轮转，单文件 5242880 字节，保留 2 份，保留 30 天

结果
  通过 —— 配置有效。
```

注入那张表不是「模板的说明」，而是**渲染后的真实结果**（用一份样例会话）。模板写错了在这一步就能看见，
不用等上游回一个 400。

`模型` 这一段最有用。它默认挑 `proxy-<映射表第一条>`，就是为了走「剥前缀 + 查映射」这条最容易出错的路径，
并给出四种结果之一：

| `结果` | 含义 |
| --- | --- |
| `（命中映射）` | 别名命中了 `model.map`，这正是你要的 |
| `（来自 model.default）` | 什么都没命中、也没剥过前缀，于是用了 `default` |
| `（剥了前缀却没有映射…）` | 前缀剥掉了，剩下的会原样发给上游——「模型不存在」多半就是这么来的 |
| `（未匹配任何前缀，原样转发…）` | 客户端填的是真实模型 ID，正常 |

想查具体某个名字，用 `--model`：

```bash
# 0 = 配置没问题，别名也解析得出来
llm-session-proxy --dry-run --model proxy-deepseek

# 1 = 你明确点名了这个别名，但它解析不出来
llm-session-proxy --dry-run --model proxy-not-a-real-alias
```

`路由分桶` 与 `变换` 两段回答的是「这条请求会落进哪个桶、会被怎么改」。以上文
[`router`](#router) 的配置为例：

```
路由分桶
  启用            是
  默认桶          default
  桶 default      （无）
  桶 background   model=glm-5.3-flash transformers=clamp-max-tokens
  桶 think        model=glm-5.3-think
  桶 longContext  model=glm-5.3-long
  #0              path^=/zen/go/v1/messages -> think
  #1              bytes>=60000 -> longContext
  #2              model~=proxy-haiku* AND bytes<=4096 -> background
  样例路由        default（默认桶，/v1/chat/completions 未命中任何规则）

变换
  全局            drop-empty-fields
  生效            drop-empty-fields
  可用            noop, drop-fields, drop-empty-fields, rename-fields, clamp-max-tokens
```

`#0`/`#1`/`#2` 就是按顺序排列的规则，`path^=` 表示「路径以此开头」，`model~=` 表示「模型前缀」。
`样例路由` 那行是真的拿一条 `POST /v1/chat/completions` 跑了一遍匹配，所以它落在兜底路径上：
一条规则都没命中，请求进默认桶。`--router think` 会覆盖这一切，把路由钉死：

```
  样例路由        think（由 --router 强制）
```

`生效` 才是真正会执行的那串：全局列表在前，命中的桶往里追加。`--doctor` 报的是同样的两段——
中文标题是 `路由分桶` 与 `变换`，刻意与既有的 `路由`（路径重写）那段区分开。

`协议互转` 那段回答「这条请求会不会被转换、转成什么」。加了 `--protocol messages` 之后，
强制目标与样例转换行会变成（`样例转换` 同时给出转换后请求要走的上游路径）：

```
协议互转
  启用            是——强制转成 "messages"
  路径            chat=/zen/go/v1/chat/completions，messages=/zen/go/v1/messages，responses=/zen/go/v1/responses
  规则            （无规则）
  样例转换        chat -> messages  /zen/go/v1/messages
```

英文输出里这一段叫 `Protocol`。

`路由分桶` 那段会列出难度打分器、档位，以及（配了打分器时）样例请求的分数。
`上游池` 那段列出每个上游的类型、线协议与凭据**来源**（绝不显示凭据本身），
以及样例请求会落到哪个上游：

```
上游池
  池子            2 个上游
  默认上游        own
  own             type=openai wire=chat|responses credential=env:OPENAI_API_KEY
  copilot         type=copilot wire=chat|responses mode=direct
  #0              gpt-5 -> copilot
  样例上游        own（default）
```

中文输出里这一段叫 `上游池`，刻意与既有的 `上游`（单个上游）那段区分开。

`--doctor` 会在这份报告之外再检查：

- `upstream.host` 的 **DNS** 解析
- 到 `upstream.host:upstream.port` 的 **TCP** 连接与握手耗时
- 协议是 `https` 时的 **TLS** 握手——证书不受信任会如实报出来，而不是直接判失败
- `listen.port` 是否空闲（只算警告，因为「已经跑着一个实例」看起来是一样的）
- `listen.port` 是否落在 WHATWG 禁用端口清单里（同样是警告，见下文）
- 对每个 `copilot` 上游做一次真实的凭据检查：取 GitHub token，调用
  `GET {baseUrl}/models`，报告来源、token 模式与可见模型数
- 一句提醒：代理只为上游池里的 provider 注入凭据；主上游仍需客户端自己带 `authorization` 头

除这次只读的 Copilot `/models` 调用外，它**不发任何 HTTP 请求**，也不消耗对话配额：可达性在传输层就回答了。
Copilot token 只会出现在请求头里，绝不进入报告。一切正常退出码为 `0`，有问题为 `1`，因此可以直接拿来当启动闸门：

```bash
llm-session-proxy --doctor && llm-session-proxy
```

### 禁用监听端口

Fetch 规范——以及所有照着它实现的浏览器——内置了一张**禁用端口**清单（6000、6666、6667、10080、5060 …）。
发往这些端口的请求会在**真正发出之前**就被拒掉，连接根本不会建立。而 Node 原生的
`http` / `https` 客户端不理会这份清单，于是这成了一种很难自查的故障：代理明明把端口绑上了、
日志也一片干净，浏览器和基于 `fetch` 的客户端却一律连不上。

由此定下两条规则，都是刻意的：

- `listen.port: 0`（让系统随便分一个）**永远不会**落到禁用端口上——分到就换个端口重绑。
  用户没点名要哪个端口，就没有需要被尊重的意图。
- 用户显式写下的端口**原样尊重**。哪怕它就在清单里，`--dry-run` / `--doctor` 也只会给出警告，
  而不是悄悄把服务搬到别的地方去。

警告里会点名端口和原因；换一个端口，并把客户端的 base URL 一起改掉。

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
| `--model-map <a=b>` | 模型名精确映射，可重复。与内置别名表逐键合并 |
| `--transformer <name>` | 挂一个命名请求体变换，可重复。是**整体替换** `transformers.enabled` 而不是追加（与 `--model-prefix` 替换 `stripPrefixes` 同理） |
| `--router <bucket>` | 强制所有请求走指定桶，忽略全部规则 |
| `--no-router` | 关闭路由分桶，即使配置文件里开着 |
| `--protocol <target>` | 转发前把所有请求转成指定协议（`chat` / `messages` / `responses` / `gemini`），压过 `protocol.routes` |
| `--no-protocol` | 关闭协议互转，即使配置文件里开着 |
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
| `--login-copilot` | 用 OAuth 设备流登录 GitHub Copilot 并保存凭据 |
| `--print-config` | 打印合并后的最终配置并退出 |
| `--dry-run` | 校验配置并打印路由、分桶、注入与模型解析结果，不产生任何网络请求 |
| `--doctor` | 同 `--dry-run`，再加 DNS/TCP/TLS 可达性、监听端口与 Copilot 凭据检查；有问题时退出码非 0 |
| `--model <id>` | `--dry-run` / `--doctor` 演示用的样例模型名 |

环境变量与配置文件同名字段一一对应（大写形式）：`PROXY_PORT`、`UPSTREAM_HOST`、
`UPSTREAM_PROTO`、`OPENCODE_UA`、`LOG_LEVEL`、`LOG_FILE`、`LOG_DIR`、`LOG_ROTATE`、
`LOG_KEEP_DAYS`、`MODEL_ALIAS_PREFIX`、`INJECT_HEADERS`（JSON）、`TRANSFORMERS`（逗号分隔）、
`ROUTER_ENABLED`、`PROTOCOL_ENABLED` 等。

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
              ├─ 3. 重写模型名：剥前缀，再查别名表
              ├─ 4. 选桶、打难度分、应用桶的模型覆盖、跑请求体变换
              ├─ 5. 选上游：桶里指定的 > 模型前缀规则 > 池子默认
              ├─ 6. 注入请求头与请求体参数
              ├─ 7. 按上游的线协议做协议互转
              └─ 8. 转发，SSE 逐块回传
```

第 3～8 步的顺序是刻意排的：规则能同时看到客户端原始模型名和解析后的模型名；桶的模型覆盖落在
别名解析之后，所以它只可能是真实 ID；**选上游必须早于协议互转**——上游决定了用哪套线协议、
也决定了往哪个 host 发；注入放在倒数第二步，请求头里的 `{{model}}` 反映的是最终
决定；**协议互转放在所有步骤之后**——变换与注入针对的是客户端协议下的字段名，等请求体定稿了，
才整体翻译成上游的协议。

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
`renderTemplate`（模板引擎）、`buildConfig`（配置合并）、`resolveRoute` / `getBucket`（选桶）、
`applyTransformers`（变换注册表）、`convertRequestBody` / `convertResponseJson`（协议互转）、
`scoreRequest` / `resolveDifficulty`（难度打分器）、
`resolvePoolUpstream` / `resolveWire`（上游池选路）、
`diagnose`（`--dry-run` 与 `--doctor` 底层跑的就是它）。

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
- **内置别名表是发布时的快照，不是活的模型目录**——上游改模型名是常态；别名失效时会告警并且告诉你该补哪条，但不会自动去拉取。真实 ID 永远原样放行，所以别名过期不会致命。
- **协议互转在边缘处刻意有损**——Anthropic 的 `thinking` / `signature` 流增量在 chat 里没有标准位置，会丢弃（日志里记名）；`messages ↔ responses` 经 chat 中转，不做直达转换器。保下来的是文本、工具调用、结束原因与 usage——客户端真正会用的就这些。
- **难度打分评的是请求*形态*，不是语义难度**——它看得到体积、轮数、代码、diff、工具、文件与明确的推理意图。一句「把它改成幂等的」和任何一句短消息分数一样低。请把它当作廉价且可解释的启发式；你明确知道情况时，还是用字节数与模型前缀两个匹配条件。
- **Copilot 的凭据来自你已有的 GitHub 登录态**——代理读一个 GitHub token（环境变量、`gh` CLI 或凭据文件）**直接**发给 `api.githubcopilot.com`；`auth.tokenMode: "session"` 才启用旧版的短命 token 交换。`ghp_` classic PAT 用不了；Copilot 的「自带密钥」仍然是客户端侧的功能——代理能做的是把一部分请求走你的订阅、另一部分走你自己的 provider 密钥。
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
git tag v0.3.1 && git push origin v0.3.1
```

workflow 会先跑完全部单元测试、校验 tag 与 `package.json` 版本一致，再用仓库 secrets 里的
`NPM_TOKEN` 发布到 registry.npmjs.org。也可以在 Actions 页面手动触发，勾选 dry run 只做干跑。

## Roadmap

这个项目刻意保持窄：**零依赖、本地、单进程**，`npx` 直接起。路线图上的每一项都必须符合这个形状。

- **v0.2 — 协议转换与路由。** Anthropic ↔ OpenAI ↔ Responses 互转、按请求规则路由。
  这是唯一能让一个客户端吃满所有模型类的功能——否则它只能用自己那套协议支持的端点。
  **已交付 v0.2.0：** 内置别名表、别名未命中告警、`--dry-run` / `--doctor`。
  **已交付 v0.2.1：** 变换注册表与路由分桶。
  **已交付 v0.2.2：** 协议转换本体——chat / messages / responses 三套协议的请求体、响应体与
  SSE 逐事件转码。
- **v0.3 — 按难度路由，以及 Copilot 与自有密钥混用。** 一个本地确定性打分器按请求形态评分并映射到
  具名档位，规则于是可以写 `{ "bucket": "think", "difficulty": "hard" }`。另一条轴上，上游池让
  一部分模型走你的 GitHub Copilot 订阅、另一部分走你自己的 provider 密钥。
  **已交付 v0.3.0：** 打分器与档位、各自带凭据的上游池，以及作为第四种线协议的 Google Gemini。
  **已交付 v0.3.1：** Copilot 改走直连——GitHub token 本身即 Bearer 凭据，不再强制交换 session
  token——并新增 `--login-copilot` 与 `--doctor` 里的真实凭据探测。
- **v0.4 — 可观测与可控。** Prometheus 格式指标、结构化 JSON 日志、token/成本统计端点、
  免构建的本地看板。
- **v0.5 — 真实上游下的可靠性。** 熔断、上游健康检查、带抖动的重试、流空闲看门狗、优雅退出。
- **v1.0 — 加固与分发。** 配置 schema 校验、按客户端的兼容性矩阵、随仓库的基准测试工具、
  单文件可执行产物。

完整的取舍、与同类网关（LiteLLM、claude-code-router、one-api、Portkey、Bifrost、Envoy AI Gateway）的功能对照、可量化的性能目标与明确的非目标，见 [ROADMAP.zh-CN.md](ROADMAP.zh-CN.md)。

## License

[Apache License 2.0](LICENSE) © 2026 alaahong
