# llm-session-proxy

[![npm version](https://img.shields.io/npm/v/llm-session-proxy.svg)](https://www.npmjs.com/package/llm-session-proxy)
[![Publish to npm](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml/badge.svg)](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-1f6feb)](https://www.ianzhang.cn/llm-session-proxy/en/)

*English · [中文文档](README.md) · [Documentation site](https://www.ianzhang.cn/llm-session-proxy/en/)*

**A configurable local reverse proxy for LLM APIs.** Zero dependencies, runnable with `npx`.

It sits between your client and the upstream API, fills in the session headers your client cannot
send, injects arbitrary custom parameters, rewrites model aliases and request paths, then forwards
the request — including streamed SSE responses — untouched.

It was originally built for [OpenCode Go](https://opencode.ai/docs/go/), but nothing in it is tied
to that provider: swap `upstream` and `inject.headers` and it fronts any OpenAI- or
Anthropic-compatible endpoint.

---

## The problem it solves

OpenCode Go / Zen API expects a session identifier on every request:

```
x-opencode-session : stable per conversation (used for prompt caching and routing)
```

When a client omits it, the upstream rejects the call outright:

```
400 Request is missing x-opencode-session and cannot be routed efficiently
```

Most clients cannot set custom request headers at all. This tool moves that job onto your machine:
point the client's base URL at the local proxy and let the proxy handle the rest.

### Which clients need this

If your client already sends a session header, you do not need this tool (though it will not hurt):

| Client | Status | Needs this proxy? |
| --- | --- | --- |
| OpenCode | Native support | No |
| Claude Code | Upstream recognizes its native session header | No |
| Codex | Recognizes the header, but some versions/proxies drop it | Only if it gets dropped |
| ZCode / Pi / jcode / Kilo Code CLI | Fixed in recent versions | Upgrade first, use this for older builds |
| Trae / self-built agents / GUI clients | Cannot customize headers | **Yes** |

---

## Features

- **Automatic session IDs** — three-tier strategy: explicit client identifier → content fingerprint
  (`system` + first user message) → one-off random. Stable within a conversation, so prompt caching
  actually works.
- **Arbitrary header and body injection** — values are templates (`{{session.id}}`, `{{uuid}}`,
  `{{env.HOME}}`, …).
- **Model alias rewriting** — prefix stripping (`proxy-glm` → `glm-5.3`) plus exact mapping, and the
  two compose.
- **Request path rewriting** — map the `/v1` your client insists on to whatever path the upstream
  actually serves.
- **Body parameter injection and removal** — add `temperature` or `metadata` to every request, or
  strip fields the upstream rejects.
- **Zero-buffer SSE pass-through** — chunks are forwarded as they arrive; streams stay streams.
  Upstream 4xx bodies are returned verbatim.
- **Zero dependencies** — Node built-ins only, so `npx` starts instantly.
- **Local status endpoint** — inspect session count, cache hit rate, and injected headers at runtime.

---

## Install and run

```bash
# Try it without installing
npx llm-session-proxy

# Or install globally
npm install -g llm-session-proxy
llm-session-proxy
```

Requires Node.js >= 18.

---

## Quick start

### 1. OpenCode Go from a client that cannot set headers

Subscribe to OpenCode Go and grab an API key at [opencode.ai/auth](https://opencode.ai/auth), then:

```bash
npx llm-session-proxy
```

Configure a custom model in your client:

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:9355/zen/go/v1` |
| Model ID | `proxy-` + the real model name, e.g. `proxy-glm-5.3-flash` |
| API Key | your OpenCode API key |

> **The `proxy-` prefix is not optional.** Clients like Trae route traffic by model ID. If you use a
> built-in preset name (such as `glm-5.3-flash`), the conversation is diverted to the client's own
> cloud channel, **bypassing this proxy entirely** — and then it still fails with a 400. The prefix
> forces traffic through the proxy, which strips it before forwarding upstream.

If your client can only be pointed at `http://127.0.0.1:9355/v1`, add a path rewrite:

```bash
npx llm-session-proxy --path-rewrite "^/v1/=>/zen/go/v1/"
```

### 2. Any OpenAI-compatible upstream

```bash
npx llm-session-proxy \
  --upstream https://api.deepseek.com \
  --port 8788 \
  --inject "x-session-id={{session.id}}" \
  --inject "x-trace-id={{uuid}}" \
  --model-map fast=deepseek-chat \
  --model-map smart=deepseek-reasoner \
  --model-prefix ""
```

Point the client at `http://127.0.0.1:8788/v1` and it can use short aliases like `fast` or `smart`.
Full version in [`examples/generic-openai.json`](examples/generic-openai.json).

### 3. A config file (recommended for daily use)

```bash
npx llm-session-proxy --init            # writes an annotated sample config
npx llm-session-proxy -c llm-session-proxy.config.json
```

The config file is JSON with comments (`//`, `/* */`) and trailing commas allowed:

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

Ready-made configs: [`examples/opencode-go.json`](examples/opencode-go.json),
[`examples/generic-openai.json`](examples/generic-openai.json),
[`examples/opencode-go-models.json`](examples/opencode-go-models.json).

### How to fill in the client's base URL

| Client can only be set to | Startup flag |
| --- | --- |
| `http://127.0.0.1:9355/zen/go/v1` | nothing needed (passed through as-is) |
| `http://127.0.0.1:9355/v1` | `--path-rewrite "^/v1/=>/zen/go/v1/"` |
| `http://127.0.0.1:9355` (no path) | `--base-path /zen/go/v1` |

---

## OpenCode Go model reference

Upstream splits models across three endpoints. **What your client can speak matters more than the
model name**, because this proxy does not translate between protocols.

**① `/zen/go/v1/chat/completions` — OpenAI-compatible; what most clients use**

| Model | Client model ID | Upstream model ID |
| --- | --- | --- |
| GLM-5.3 | `proxy-glm` / `proxy-glm-5.3` | `glm-5.3` |
| GLM-5.3-Flash | `proxy-glm-flash` | `glm-5.3-flash` |
| GLM-5.2 / 5.1 | `proxy-glm-5.2` | `glm-5.2` |
| Kimi K3 | `proxy-kimi` | `kimi-k3` |
| Kimi K2.7 Code | `proxy-kimi-code` | `kimi-k2.7-code` |
| Kimi K2.6 | `proxy-kimi-k2.6` | `kimi-k2.6` |
| DeepSeek V4.1 Flash | `proxy-deepseek` | `deepseek-flash` |
| DeepSeek V4 Pro | `proxy-deepseek-pro` | `deepseek-v4-pro` |
| DeepSeek V4 Flash | `proxy-deepseek-v4-flash` | `deepseek-v4-flash` |
| DeepSeek V4 Flash Vision Exp | `proxy-deepseek-vision` | `deepseek-v4-flash-vision-exp` |
| LongCat-2.0 | `proxy-longcat` | `longcat-2.0` |
| MiMo-V2.5 / Pro | `proxy-mimo` | `mimo-v2.5` |
| Hy3 / Hy4 preview | `proxy-hy3` | `hy3` |

**② `/zen/go/v1/responses` — OpenAI Responses API; the client must speak that protocol**

| Model | Client model ID | Upstream model ID |
| --- | --- | --- |
| Grok 4.6 | `proxy-grok` | `grok-4.6` |
| GPT 5.6 Luna | `proxy-gpt-luna` | `gpt-5.6-luna` |
| Muse Spark 1.3 / 1.2 Contributor | `proxy-muse-1.3` | `muse-spark-1.3-contributor` |

**③ `/zen/go/v1/messages` — Anthropic Messages API; the client must send Anthropic-shaped bodies**

| Model | Client model ID | Upstream model ID |
| --- | --- | --- |
| MiniMax M3 / M2.7 / M2.5 | `proxy-minimax` | `minimax-m3` |
| Qwen3.8 Max | `proxy-qwen-max` | `qwen3.8-max` |
| Qwen3.8 Flash | `proxy-qwen-flash` | `qwen3.8-flash` |
| Qwen3.7 / 3.6 Plus | `proxy-qwen-plus` | `qwen3.6-plus` |

> This proxy performs **no protocol translation**. If your client sends OpenAI-shaped bodies,
> categories ② and ③ are unusable: the proxy fills headers, rewrites the model name, and reroutes
> the path, but it will not turn a Chat Completions body into a Messages body.
>
> Writing the real upstream ID directly (no alias, no prefix) also works — it is passed through.
> The model list changes over time; treat the
> [upstream docs](https://opencode.ai/docs/go/) as the source of truth.

---

## Configuration reference

Priority: **defaults < config file < environment variables < CLI flags**.

### `listen`

| Field | Default | Description |
| --- | --- | --- |
| `host` | `127.0.0.1` | Bind address. Loopback only — do **not** use `0.0.0.0`, or anyone on your network can spend your quota |
| `port` | `9355` | Port |

### `upstream`

| Field | Default | Description |
| --- | --- | --- |
| `protocol` | `https` | `https` or `http` |
| `host` | `opencode.ai` | May also be a full URL, which gets parsed automatically |
| `port` | `null` | `null` means the protocol default (443 / 80) |
| `basePath` | `""` | Prefix prepended to every forwarded path, e.g. `/zen/go/v1` |
| `rewriteHost` | `true` | Whether to rewrite the `Host` header |

### `request`

| Field | Default | Description |
| --- | --- | --- |
| `bufferBody` | `true` | Must be `true` to rewrite the body (model name, parameter injection) |
| `maxBodyBytes` | `67108864` | Request body limit (64 MB); larger returns 413 |
| `timeoutMs` | `600000` | Upstream timeout |
| `pathRewrite` | `[]` | Rules as `{ "pattern": "regex", "replacement": "..." }` |
| `dropHeaders` | `[]` | Headers (lowercase) not forwarded upstream |
| `forwardClientSessionHeaders` | `true` | Forward the client's own session headers |

### `session`

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable session ID injection |
| `headerNames` | `x-opencode-session`, 4 more | Tried in order to read the client's session ID |
| `bodyFields` | `session_id`, … | Tried in order on the request body (dot paths supported) |
| `contentHash.enabled` | `true` | Fall back to a content fingerprint |
| `contentHash.fields` | `["system", "system_instruction", "instructions"]` | Fields used for the fingerprint |
| `contentHash.includeFirstUserMessage` | `true` | Whether the first user message participates |
| `idPrefix` | `ses_` | Prefix for generated IDs |
| `idFormat` | `hex26` | `hex26` / `hex` / `uuid` / `base36` / `short` |
| `requestIdFormat` | `msg_{{session.count}}` | Request-id template |
| `maxSessions` | `512` | Session table cap; oldest evicted first |
| `ttlSeconds` | `0` | Expiry in seconds; `0` disables expiry |

### `inject`

| Field | Default | Description |
| --- | --- | --- |
| `headers` | 4 `x-opencode-*` headers | Headers to inject; values are templates. Set to `null` to skip one |
| `body` | `{}` | Fields merged into the request body (dot paths and templates supported) |
| `removeBodyFields` | `[]` | Body field paths to delete |
| `overwrite` | `true` | `false` keeps the client's existing header/field |

### `model`

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable model rewriting |
| `field` | `model` | Body field holding the model name |
| `stripPrefixes` | `["proxy-"]` | Prefixes to strip, first match wins |
| `map` | `{}` | Exact mapping. Looked up by original name first, then again after prefix stripping |
| `default` | `null` | Fallback model |

### Response, UA and logging

| Field | Default | Description |
| --- | --- | --- |
| `userAgent` | `opencode/1.18.29 cli` | Injected UA |
| `userAgentMode` | `replace-generic` | `keep` preserves the client UA; `replace` always overrides; `replace-generic` only when missing or library-like |
| `response.stream` | `true` | Stream pass-through. `false` buffers everything (**breaks SSE**) |
| `log.level` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `log.file` | `null` | Extra log file, rotated by size |

---

## Template variables

| Variable | Meaning |
| --- | --- |
| `{{session.id}}` | Session ID used for this request |
| `{{session.count}}` | Nth request within the session (1-based) |
| `{{session.requestId}}` | Rendered from `requestIdFormat`, e.g. `msg_3` |
| `{{session.source}}` | `header:*` / `body:*` / `content-hash` / `random` |
| `{{model}}` | Model name after rewriting |
| `{{path}}` / `{{method}}` | Original path / method |
| `{{header.x-foo}}` | Client header (lowercase) |
| `{{query.foo}}` | Query parameter |
| `{{env.HOME}}` | Environment variable |
| `{{uuid}}` | Fresh UUID per render |
| `{{random}}` / `{{randomHex:16}}` | Random hex, default 26 / 16 chars |
| `{{timestamp}}` / `{{timestampMs}}` | Seconds / milliseconds |

---

## CLI reference

| Flag | Description |
| --- | --- |
| `-c, --config <file>` | Read a config file |
| `-p, --port <n>` / `--host <addr>` | Listen port / address |
| `-u, --upstream <url>` | Upstream, e.g. `https://opencode.ai` or `host:port` |
| `--base-path <path>` | Forwarding path prefix |
| `--path-rewrite <a=>b>` | Path rewrite (regex), repeatable |
| `--inject <name=value>` | Inject a header, repeatable |
| `--body-inject <k=v>` | Inject a body field (dot paths), repeatable |
| `--model-prefix <prefix>` | Prefix to strip, repeatable |
| `--model-map <a=b>` | Exact model mapping, repeatable |
| `--session-header <name>` / `--session-field <path>` | Add a session source, repeatable |
| `--session-id-format <f>` / `--request-id-format <t>` | Session ID format / request-id template |
| `--no-session` / `--no-stream` | Disable session injection / disable streaming |
| `--timeout <ms>` / `--max-body <bytes>` | Upstream timeout / body limit |
| `--log-level <l>` / `--log-file <f>` | Log level / log file |
| `--init [file]` | Write a sample config |
| `--print-config` | Print the merged config and exit |

Environment variables mirror the config field names in uppercase: `PROXY_PORT`, `UPSTREAM_HOST`,
`UPSTREAM_PROTO`, `OPENCODE_UA`, `LOG_LEVEL`, `LOG_FILE`, `MODEL_ALIAS_PREFIX`, `INJECT_HEADERS`
(JSON), and so on.

### Local status endpoints

```bash
# Overview: session count, hit rate, injected headers, upstream
curl http://127.0.0.1:9355/__llm_session_proxy__/status

# Per-session detail
curl http://127.0.0.1:9355/__llm_session_proxy__/sessions
```

Handy when debugging: if `sessions.active` stays at 0, requests never reached the proxy — usually
because the model ID is missing the `proxy-` prefix and the client intercepted it.

---

## How it works

```
client ──▶ llm-session-proxy ──▶ upstream API
              │
              ├─ 1. read and parse the request body
              ├─ 2. resolve the session: explicit > fingerprint > random
              ├─ 3. rewrite path and model name
              ├─ 4. inject headers and body parameters
              └─ 5. forward, streaming SSE chunks back as they arrive
```

The three-tier session resolution is what keeps IDs stable within a conversation:

1. **Explicit** — the client already sent `x-opencode-session`, or the body carries `session_id`.
   Reused verbatim; most accurate.
2. **Content fingerprint** — SHA-256 over `system` plus the first user message. Later turns only
   append messages, so the anchor stays stable and the ID is reused.
3. **One-off random** — neither is available (e.g. a non-JSON body). A random ID is issued so the
   upstream will not 400; these requests are not stored, keeping the session table from growing.

---

## Use as a library

```js
import { startProxy, buildConfig, createProxyServer } from 'llm-session-proxy';

const proxy = await startProxy({
  flags: {
    listen: { port: 9355 },
    upstream: { host: 'opencode.ai' },
    inject: { headers: { 'x-opencode-session': '{{session.id}}' } },
  },
});

console.log(`listening on ${proxy.url}`);
console.log(`active sessions: ${proxy.store.size}`);

await proxy.stop();
```

You can also take just the parts you need: `createProxyServer` (own the lifecycle),
`SessionStore` (session table), `renderTemplate` (template engine), `buildConfig` (config merging).

---

## Stability

- **A single malformed request cannot take the process down.** Synchronous throws along the
  request path are intercepted: an invalid `Host` header, a malformed request line, or an upstream
  status line / header containing illegal characters all become ordinary 4xx / 5xx responses, and
  the proxy keeps serving.
- **Uncaught errors land in the log file.** A last-resort handler writes the full stack of
  `uncaughtException` and `unhandledRejection` into the file given by `--log-file` (and to stderr).
  Node's default is to print to stderr and terminate immediately — leaving nothing at all in the
  log file, which looks exactly like "the logs are fine, the process just vanished".
  **Always pass `--log-file`**, otherwise process-level clues disappear with the terminal window.
- 20 uncaught errors within 60 seconds are treated as a persistent fault and the process exits on
  purpose, rather than spinning in a broken state.

---

## FAQ

**The client cannot connect, and the proxy logs nothing**

Check that the base URL points at the proxy and that the model ID carries the `proxy-` prefix. The
latter is by far the most common cause — clients like Trae divert traffic by model ID.

**Still a 400 about the missing session header**

Look at the `session=` field in the proxy log for that request. A value there means the proxy
injected it but the upstream did not see it — check whether `inject.headers` got overwritten by a
config file. No value means `session.enabled` is off.

**Long conversations get slower; prompt caching never hits**

The session ID is not stable. Check whether the client mutates `system` or the first user message
every turn (some clients inject timestamps or the current file path). Either switch to an explicit
session header, or narrow `contentHash.fields` to the most stable field.

**Will the injected headers confuse a different upstream?**

No. Headers the upstream does not recognize are harmless extras. For a clean request set
`inject.headers` to `{}` or keep only the ones you need.

**Port already in use**

On `EADDRINUSE`, pick another port (`--port 9356`) and update the client's base URL.

---

## Limitations

- **Loopback only (127.0.0.1).** The proxy forwards your API key; do not bind it to `0.0.0.0`.
- **`response.stream: false` breaks SSE.** Keep it `true` unless you genuinely need full buffering.
- **`bufferBody: false` disables body rewriting.** Model rewriting and parameter injection stop
  working; only header injection and header-based session detection remain.
- The proxy only forwards and patches. It does not cache, meter usage, or modify responses.

---

## Releasing a new version

Publishing is handled by GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml));
no local `npm login` required:

1. Bump `version` in `package.json`
2. Commit and push
3. Tag and push the matching tag:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

The workflow runs the full test suite, verifies the tag matches `package.json`, then publishes to
registry.npmjs.org using the `NPM_TOKEN` repository secret. It can also be triggered manually from
the Actions tab, optionally as a dry run.

> The secret must be an **Automation** token (npmjs.com → Access Tokens → Classic Token →
> Automation). A 2FA-protected Publish token will fail in CI with `EOTP`.

## License

[Apache License 2.0](LICENSE) © 2026 alaahong
