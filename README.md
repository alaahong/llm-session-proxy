# llm-session-proxy

[![npm version](https://img.shields.io/npm/v/llm-session-proxy.svg)](https://www.npmjs.com/package/llm-session-proxy)
[![Publish to npm](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml/badge.svg)](https://github.com/alaahong/llm-session-proxy/actions/workflows/publish.yml)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-1f6feb)](https://www.ianzhang.cn/llm-session-proxy/)

*English · [中文文档](README-zh-CN.md) · [Documentation site](https://www.ianzhang.cn/llm-session-proxy/) · [Roadmap](ROADMAP.md)*

> The Chinese README is intentionally named `README-zh-CN.md` (hyphen, not dot). When building the
> npm package page, npm picks the **first** file matching the glob `{README,README.*}` — in practice
> `README.zh-CN.md` sorts ahead of `README.md` and the page would show the Chinese version. The
> hyphenated name does not match that glob, so the English README is always selected.

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
  two compose. A curated alias table for OpenCode Go ships in the box, so the `proxy-` prefix the
  docs tell you to use actually resolves out of the box; when an alias strips down to something
  unmapped, the proxy says so instead of quietly forwarding a model name that does not exist.
- **Rule-based routing into buckets** — `default` / `background` / `think` / `longContext`, each with
  its own model override and body transforms. Rules match on path prefix, model prefix, a body field,
  or request size; they run **top-down with first match winning**, and the conditions inside a single
  rule are ANDed. Off by default, so upgrading changes nothing.
- **Composable body transformers** — five named, in-tree transforms (`drop-fields`,
  `drop-empty-fields`, `rename-fields`, `clamp-max-tokens`, `noop`) applied globally or per bucket, in
  a fixed order. The registry is a hard-coded list on purpose: **the proxy never loads code from a
  path**, which is what keeps "zero dependencies, loopback only" honest.
- **Request path rewriting** — map the `/v1` your client insists on to whatever path the upstream
  actually serves.
- **Body parameter injection and removal** — add `temperature` or `metadata` to every request, or
  strip fields the upstream rejects.
- **Zero-buffer SSE pass-through** — chunks are forwarded as they arrive; streams stay streams.
  Upstream 4xx bodies are returned verbatim.
- **Log file on by default** — `~/.lsp/logs/llm-session-proxy.log` with size or date rotation and
  30-day archival, so a vanished process still leaves clues behind.
- **Preflight checks** — `--dry-run` prints how a request would be routed, which headers get
  injected, and how a model name resolves, without sending anything; `--doctor` adds DNS/TCP/TLS
  reachability and listen-port checks and exits non-zero on problems.
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

Every `Client model ID` below resolves out of the box: these aliases ship in the built-in
`model.map` table (`src/models.js`). `--dry-run --model proxy-glm` shows you exactly what any given
alias turns into.

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
> the path, but it will not turn a Chat Completions body into a Messages body. (This is the headline
> item on the [roadmap](ROADMAP.md) for v0.2.2.)
>
> Writing the real upstream ID directly (no alias, no prefix) also works — it is passed through.
> The model list changes over time; treat the
> [upstream docs](https://opencode.ai/docs/go/) as the source of truth. If you point the proxy at a
> different upstream, the built-in aliases will not match its model names — supply your own
> `model.map` and watch for the unmatched-alias warning described below.

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
| `map` | 27 built-in aliases | Alias → real upstream model ID. Merged **key by key** over the built-in table: a key here overrides the built-in entry of the same name and the rest are kept. Built-in entries cannot be deleted from a config file — override them instead |
| `default` | `null` | Fallback model. Only applies to a name that matched nothing *and* had no prefix stripped; it deliberately does not rescue `proxy-xxx` that strips to an unmapped `xxx` |
| `warnUnmapped` | `true` | Warn once per alias that strips to a name with no mapping and no `default` |

How a client-supplied name is resolved:

1. `map` hit on the **original** name — wins outright, no stripping.
2. Otherwise strip the first matching `stripPrefixes` entry, then look the stripped name up in `map`.
   This is what makes both `proxy-glm` and `glm` work.
3. If the name was untouched and nothing matched, use `default`.
4. Otherwise forward as-is.

Step 4 is where "model not found" errors come from: a client sends `proxy-<something>` that is not in
the table, the prefix is stripped, and the remainder goes upstream verbatim. Unless it happens to be
a real upstream ID, the upstream rejects it. The proxy now says which entry is missing:

```
[model] alias "proxy-mystery" matched no mapping after stripping "proxy-" — forwarding "mystery"
        to the upstream as-is. Add model.map["mystery"], or have the client send the real model id.
```

It fires at most once per alias per process, so a chatty client cannot flood the log. Set
`"warnUnmapped": false` to silence it. Names sent without a matching prefix are never warned about —
forwarding a real upstream ID is normal and expected.

### `transformers`

Body transforms that run on every request, router or not. Names only: the registry is a fixed list
compiled into the proxy, so a config file can never make it execute arbitrary code.

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `[]` | Transformer names, applied **left to right** |
| `options` | `{}` | Per-transformer options, keyed by transformer name |

| Name | Options | Effect |
| --- | --- | --- |
| `noop` | — | Changes nothing. Useful for confirming the registry is wired up |
| `drop-fields` | `fields: ["a.b"]` | Delete the listed dot paths |
| `drop-empty-fields` | `fields?: [...]` | Delete fields that are `null`, `""`, `[]` or `{}`. `0` and `false` survive. Without `fields`, every top-level key is inspected |
| `rename-fields` | `map: { "from": "to" }` | Rename dot paths, creating parent objects as needed. A mapping onto itself is ignored |
| `clamp-max-tokens` | `max: 4096`, `fields?: [...]` | Lower `max_tokens` / `max_completion_tokens` to at most `max`. Never raises a value; a missing or non-positive `max` is a no-op |

Order matters, because each transformer mutates the body in place — running `rename-fields` before
`drop-fields` is not the same as the reverse.

```json
"transformers": {
  "enabled": ["drop-empty-fields"],
  "options": { "drop-empty-fields": { "fields": ["temperature", "top_p"] } }
}
```

A name that is not in the table is a **startup error**, not a silent no-op.

### `router`

Splits traffic into buckets. A bucket decides two things: which **model** to use and which
**transforms** to attach. `enabled` is `false` by default, so an existing config behaves exactly as
before until you turn it on.

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Master switch. `--no-router` forces it off |
| `forced` | `null` | Pin every request to this bucket, ignoring all rules (`--router <bucket>`). It outranks `enabled: false` as well — naming a bucket explicitly should not be silently ignored |
| `defaultBucket` | `default` | Where requests that match no rule go |
| `buckets` | the four built-ins, all empty | `{ "model": <id or null>, "transformers": [<name>] }`. Custom bucket names may be added; an undeclared name degrades to an empty bucket |
| `rules` | `[]` | See below |

A rule needs a `bucket` plus **at least one** matcher. Zero matchers is a config error: a rule that
cannot be evaluated is not the same as a rule that matches everything.

| Matcher | Matches when |
| --- | --- |
| `path` | The request path **starts with** this string. Matched against the path the client sent, before `request.pathRewrite` |
| `modelPrefix` | Either the model **the client sent** or the model **after rewriting** starts with this, so `proxy-think` and `glm-5.3` are both usable as rule material |
| `bodyField` | That dot path exists and is non-empty (`0` and `false` count as non-empty). Add `bodyFieldValue` to require one exact value instead |
| `minBytes` / `maxBytes` | Request body size, inclusive on both ends |

Rules are evaluated **top-down and the first match wins**, with the conditions inside one rule ANDed
— so write them from specific to broad. Sizes are **bytes, not tokens**: estimating tokens would mean
shipping a tokenizer, and a byte count is a figure you can actually tune.

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

A bucket's `transformers` are **appended** to the global `transformers.enabled` list: a bucket can add
transforms but cannot cancel a global one. Drop it from the global list instead.

A bucket's `model` is applied *after* alias rewriting and replaces whatever was there, so it should be
a real upstream model ID rather than a `proxy-` alias. Header templates referencing `{{model}}` see the
bucket's value, because injection runs last.

### Response, UA and logging

| Field | Default | Description |
| --- | --- | --- |
| `userAgent` | `opencode/1.18.29 cli` | Injected UA |
| `userAgentMode` | `replace-generic` | `keep` preserves the client UA; `replace` always overrides; `replace-generic` only when missing or library-like |
| `response.stream` | `true` | Stream pass-through. `false` buffers everything (**breaks SSE**) |
| `log.level` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `log.file` | `null` | `null` uses the default location (§Logs): `~/.lsp/logs/llm-session-proxy.log`. A path writes there. `false` disables the file (console only) |
| `log.dir` | `null` | Directory only — keeps the default file name |
| `log.rotate` | `size` | `size` / `daily` / `off` |
| `log.maxBytes` | `5242880` | Rotate once a file would exceed this (`size` and `daily` modes) |
| `log.backups` | `2` | How many `.1`/`.2` backups to keep. `0` discards old content instead |
| `log.keepDays` | `30` | Delete logs older than N days. `0` keeps them forever |
| `lang` | `en` | Language of console output and log messages: `en` / `zh` |

---

## Logs

**Logging to disk is on by default**, because the process-level failures that are hardest to
diagnose — an uncaught exception, a silent crash — leave nothing behind on stderr once the
terminal is gone.

| What | Where |
| --- | --- |
| Default file | `$LSP_HOME/logs/llm-session-proxy.log`, or `~/.lsp/logs/llm-session-proxy.log` when `LSP_HOME` is unset |
| Own file | `log.file` / `--log-file <path>`, or `LOG_FILE=<path>` |
| Own directory | `log.dir` / `--log-dir <dir>`, or `LOG_DIR=<dir>` (default file name is kept) |
| Turn it off | `--no-log-file`, `"file": false`, or `LOG_FILE=off` |

Rotation, chosen with `log.rotate` / `--log-rotate` / `LOG_ROTATE`:

| Mode | Behaviour |
| --- | --- |
| `size` (default) | `app.log` grows to `log.maxBytes`, then becomes `app.log.1`, `.2` … up to `log.backups` |
| `daily` | One file per local date: `app-YYYY-MM-DD.log`. `log.maxBytes` still caps a single day's file |
| `off` | Never rotate or truncate — hand the file to `logrotate` or similar |

**Archival.** On startup, and at most once every six hours while running, the logger deletes
files matching its own naming pattern (`app.log`, `app.log.N`, `app-YYYY-MM-DD.log`) whose
mtime is older than `log.keepDays` (default **30**, `0` = keep forever). The file currently
being written is never deleted, and files that do not match the pattern — including anything
else in the same directory — are left alone.

A quick way to confirm where logs actually land:

```bash
llm-session-proxy --print-config | grep resolvedFile
```

`log.file` stays `null` when you rely on the default location; `log.resolvedFile` in
`--print-config` output is the absolute path the logger will open.

---

## Preflight: `--dry-run` and `--doctor`

Both flags validate the config and print what the proxy would actually do, then exit — no server, no
log file, no request to the upstream.

```bash
llm-session-proxy --dry-run
```

```
llm-session-proxy v0.2.1 — dry run

Config
  file                (none)
  language            en
  listen              127.0.0.1:9355

Upstream
  url                 https://opencode.ai
  host header         opencode.ai
  base path           (none)
  rewrite host        yes
  user agent          opencode/1.18.29 cli (mode replace-generic)

Routing
  path rewrite        (none, passed through as-is)
  session from        header x-opencode-session, x-session-id, … ; body session_id, sessionId, …
  session id          hex26 | msg_{{session.count}}

Injection
  header              x-opencode-session = {{session.id}}  ->  ses_378f3582ae608b101b83606614
  header              x-opencode-request = {{session.requestId}}  ->  msg_1
  …

Model
  sample              proxy-glm
  strip               prefix "proxy-" -> glm
  mapped              glm -> glm-5.3
  result              glm-5.3  (mapped)
  map                 27 built-in aliases, 0 overrides

Router
  enabled             no
  default bucket      default
  bucket default      (none)
  bucket background   (none)
  bucket think        (none)
  bucket longContext  (none)
  rules               (no rules)
  sample route        default (router disabled)

Transformers
  global              (none)
  effective           (none)
  available           noop, drop-fields, drop-empty-fields, rename-fields, clamp-max-tokens

Log
  file                ~/.lsp/logs/llm-session-proxy.log
  rotation            size rotation, max 5242880 B, 2 backups, keep 30 days

Result
  OK — the configuration is valid.
```

The injection table is not a description of the templates — it is the **rendered** result, using a
sample session. If a template is misspelled you see it here rather than in a 400 from the upstream.

The `Model` block is the interesting one. It picks `proxy-<first alias>` by default precisely because
that exercises the strip-then-map path, and reports which of the four outcomes applies:

| `result` | Meaning |
| --- | --- |
| `(mapped)` | The alias hit `model.map`. This is what you want |
| `(from model.default)` | Nothing matched and nothing was stripped, so `default` applied |
| `(prefix stripped, NO mapping …)` | The prefix came off and the remainder is going upstream verbatim — the usual cause of "model not found" |
| `(no prefix matched, forwarded as-is …)` | The client sent a real model ID. Normal |

Pass `--model` to check a specific name:

```bash
# 0 = the config is fine and the alias resolves
llm-session-proxy --dry-run --model proxy-deepseek

# 1 = you named this alias explicitly and it resolves to nothing
llm-session-proxy --dry-run --model proxy-not-a-real-alias
```

The `Router` and `Transformers` blocks answer "which bucket would this request land in, and what would
be done to it". For the config in [§`router`](#router) above:

```
Router
  enabled             yes
  default bucket      default
  bucket default      (none)
  bucket background   model=glm-5.3-flash transformers=clamp-max-tokens
  bucket think        model=glm-5.3-think
  bucket longContext  model=glm-5.3-long
  #0                  path^=/zen/go/v1/messages -> think
  #1                  bytes>=60000 -> longContext
  #2                  model~=proxy-haiku* AND bytes<=4096 -> background
  sample route        default  (default bucket, no rule matched /v1/chat/completions)

Transformers
  global              drop-empty-fields
  effective           drop-empty-fields
  available           noop, drop-fields, drop-empty-fields, rename-fields, clamp-max-tokens
```

`#0`/`#1`/`#2` are the rules in order, with `path^=` meaning "path starts with" and `model~=` meaning
"model prefix". The `sample route` row is the result of actually running the matcher over a sample
`POST /v1/chat/completions`, so it shows the fallback path: nothing matched and the request goes to the
default bucket. `--router think` overrides the whole thing and pins the route:

```
  sample route        think  (forced by --router)
```

`effective` is what will really run, global list first, then whatever the winning bucket appends.
`--doctor` shows the same blocks — in Chinese output they are titled `路由分桶` and `变换`, deliberately
distinct from the pre-existing `路由` (path rewriting) section.

`--doctor` runs the same report and then checks, in addition:

- **DNS** resolution of `upstream.host`
- **TCP** connect to `upstream.host:upstream.port`, with handshake time
- **TLS** handshake when the protocol is `https` — the certificate is reported if it is not trusted,
  rather than treated as a hard failure
- whether `listen.port` is free (reported as a warning, since a running instance looks the same)
- a reminder that the proxy never injects credentials

It sends **no HTTP request** and no credentials: reachability is answered at the transport layer, so
a doctor run never burns rate-limit quota. It exits `0` when everything is fine and `1` when
something needs fixing, which makes it usable as a startup gate:

```bash
llm-session-proxy --doctor && llm-session-proxy
```

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
| `--model-map <a=b>` | Exact model mapping, repeatable. Merged over the built-in alias table |
| `--transformer <name>` | Attach a named body transform, repeatable. **Replaces** `transformers.enabled` rather than appending to it, the same way `--model-prefix` replaces `stripPrefixes` |
| `--router <bucket>` | Force every request through one bucket, ignoring the rules |
| `--no-router` | Turn router buckets off, even if the config file enables them |
| `--session-header <name>` / `--session-field <path>` | Add a session source, repeatable |
| `--session-id-format <f>` / `--request-id-format <t>` | Session ID format / request-id template |
| `--no-session` / `--no-stream` | Disable session injection / disable streaming |
| `--timeout <ms>` / `--max-body <bytes>` | Upstream timeout / body limit |
| `--log-level <l>` | Log level |
| `--log-file <f>` / `--no-log-file` | Log file path / turn file logging off |
| `--log-dir <dir>` | Directory of the default log file |
| `--log-rotate <mode>` | `size` / `daily` / `off` |
| `--log-keep-days <n>` | Delete logs older than N days (`0` = keep forever) |
| `-l, --lang <en\|zh>` | Language of console output and log messages (default `en`) |
| `--init [file]` | Write a sample config |
| `--print-config` | Print the merged config and exit |
| `--dry-run` | Validate the config and print routing, buckets, injection and model resolution. No network I/O |
| `--doctor` | `--dry-run` plus DNS/TCP/TLS reachability and listen-port checks; exits non-zero on problems |
| `--model <id>` | Sample model name used by `--dry-run` / `--doctor` |

Environment variables mirror the config field names in uppercase: `PROXY_PORT`, `UPSTREAM_HOST`,
`UPSTREAM_PROTO`, `OPENCODE_UA`, `LOG_LEVEL`, `LOG_FILE`, `LOG_DIR`, `LOG_ROTATE`,
`LOG_KEEP_DAYS`, `MODEL_ALIAS_PREFIX`, `INJECT_HEADERS` (JSON), `TRANSFORMERS` (comma-separated),
`ROUTER_ENABLED`, and so on.

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
              ├─ 3. rewrite the model name: prefix stripping, then the alias table
              ├─ 4. pick a bucket, apply its model override, run the body transforms
              ├─ 5. inject headers and body parameters
              └─ 6. forward, streaming SSE chunks back as they arrive
```

The order of 3–5 is deliberate. Rules see the model name the client sent *and* the resolved one, the
bucket's model override lands after alias resolution so it can only be a real upstream ID, and
injection comes last so `{{model}}` in a header reflects the final decision rather than the original
request.

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
`SessionStore` (session table), `renderTemplate` (template engine), `buildConfig` (config merging),
`resolveRoute` / `getBucket` (bucket selection), `applyTransformers` (the transform registry), and
`diagnose` (what `--dry-run` and `--doctor` run under the hood).

---

## Stability

- **A single malformed request cannot take the process down.** Synchronous throws along the
  request path are intercepted: an invalid `Host` header, a malformed request line, or an upstream
  status line / header containing illegal characters all become ordinary 4xx / 5xx responses, and
  the proxy keeps serving.
- **Uncaught errors land in the log file.** A last-resort handler writes the full stack of
  `uncaughtException` and `unhandledRejection` into the log file (and to stderr). Node's default is
  to print to stderr and terminate immediately — leaving nothing at all in the log file, which
  looks exactly like "the logs are fine, the process just vanished". This is why **file logging is
  on by default**: it goes to `~/.lsp/logs/llm-session-proxy.log` unless you say otherwise.
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
- **The built-in alias table is a snapshot, not a live catalogue.** Upstream renames models; when an
  alias stops resolving you get a warning naming the entry to add, but nothing is fetched
  automatically. Real model IDs are always passed through, so a stale alias is never fatal.
- The proxy only forwards and patches. It does not cache, meter usage, or modify responses.

---

## Releasing a new version

Publishing is handled by GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml));
no local `npm login` required:

1. Bump `version` in `package.json`
2. Commit and push
3. Tag and push the matching tag:

```bash
git tag v0.2.1 && git push origin v0.2.1
```

The workflow runs the full test suite, verifies the tag matches `package.json`, then publishes to
registry.npmjs.org using the `NPM_TOKEN` repository secret. It can also be triggered manually from
the Actions tab, optionally as a dry run.

> The secret must be an **Automation** token (npmjs.com → Access Tokens → Classic Token →
> Automation). A 2FA-protected Publish token will fail in CI with `EOTP`.

## Roadmap

The project is deliberately narrow: a **zero-dependency, local, single-process** proxy you can
start with `npx`. Everything on the roadmap has to fit that shape.

- **v0.2 — protocol translation and routing.** Anthropic ↔ OpenAI ↔ Responses conversion,
  rule-based routing per request. This is the one feature that lets a single client reach every
  model class instead of only the endpoints its own protocol supports.
  **Delivered — v0.2.0:** the built-in alias table, the unmatched-alias warning, and
  `--dry-run` / `--doctor`. **Delivered — v0.2.1:** the transformer registry and router buckets.
  **Next — v0.2.2:** the protocol translation itself, which is the riskiest piece and gets a release
  of its own.
- **v0.3 — observability and control.** Prometheus-format metrics, structured JSON logs, a
  cost/token accounting endpoint, and a zero-build local dashboard.
- **v0.4 — reliability under real upstreams.** Circuit breaking, upstream health checks,
  retry with jitter, stream idle watchdogs, graceful drain on shutdown.
- **v1.0 — hardening and distribution.** Config schema validation, a compatibility matrix per
  client, a checked-in benchmark harness, and single-file binaries.

See [ROADMAP.md](ROADMAP.md) for the full rationale, the feature matrix against comparable
gateways (LiteLLM, claude-code-router, one-api, Portkey, Bifrost, Envoy AI Gateway), the
measurable performance targets, and the explicit non-goals.

## License

[Apache License 2.0](LICENSE) © 2026 alaahong
