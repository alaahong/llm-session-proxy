# Roadmap

`llm-session-proxy` is a **zero-dependency, local, single-process reverse proxy** for LLM APIs. It
exists to fix one thing well: clients that cannot send the headers an upstream demands. Everything
below has to fit that shape.

- **Scope:** one developer machine, one process. One upstream by default; a pool of upstreams since v0.3.0.
- **Non-negotiable:** `dependencies` in `package.json` stays empty. Features that would need a
  library get re-implemented on Node built-ins, or they do not ship.
- **Status:** v0.3.1 — the session/header injection core works and is hardened; model aliasing,
  `--dry-run` / `--doctor`, the transform registry, routing buckets, protocol conversion, difficulty
  scoring and the multi-upstream pool have shipped. Everything else is on this page.

---

## 1. Where it stands today

### Working (v0.3.0)

| Area | What ships now |
| --- | --- |
| Sessions | Three-tier resolution: explicit client identifier → content fingerprint (`system` + first user message) → one-off random. Stable per conversation, so upstream prompt caching works. |
| Injection | Arbitrary request headers and body fields, templated (`{{session.id}}`, `{{uuid}}`, `{{env.HOME}}`, …), with dot-path support and an `overwrite` switch. |
| Rewriting | Model aliases (exact map + prefix stripping, composable) and request paths (regex rules). A curated OpenCode Go alias table now ships **in the box**, so the `proxy-` prefix the README prescribes resolves without a config file; an alias that strips down to something unmapped is reported by name instead of being forwarded silently. |
| Routing | Four buckets (`default` / `background` / `think` / `longContext`), each with its own model override and transform list. Rules match on path prefix, model prefix, body field, request size or **difficulty band**, evaluate **top-down with the first match winning**, and AND the conditions inside one rule. **Off by default**, so upgrading changes nothing. |
| Difficulty | A named in-tree **scorer registry** (`builtin-complexity`) turns the request's shape into a 0–100 score and a band (`easy` / `medium` / `hard`), which the router can match on. Nine weighted signals, deterministic, no network, no model call. Measures the *shape* of a request, not its semantic difficulty. |
| Upstreams | A **pool** of upstreams (`openai` / `anthropic` / `gemini` / `copilot` / `custom`), each with its own base URL, endpoint paths, wire protocol and credential source. The bucket picks the upstream explicitly, otherwise the model name picks it by prefix, otherwise the pool default does. Request bodies are converted to whichever **wire protocol** the chosen upstream speaks. |
| Copilot | GitHub Copilot as a first-class upstream: the GitHub token goes **straight** to `api.githubcopilot.com` as the Bearer credential (OMP-style; the `copilot_internal/v2/token` exchange is opt-in via `auth.tokenMode: "session"`), with the official `Copilot-Integration-Id` and API-version headers and per-model endpoint selection. Credentials are read from the environment, the `gh` CLI, an archived file or a device-flow login, and **never written to config or to logs**. |
| Transforms | Five named in-tree body transforms (`noop`, `drop-fields`, `drop-empty-fields`, `rename-fields`, `clamp-max-tokens`), attachable globally or per bucket, applied in a fixed order. Selected **by name, never by path**, so a config file cannot make the proxy execute code. |
| Protocol | Anthropic Messages ↔ OpenAI Chat Completions ↔ OpenAI Responses ↔ **Google Gemini**: request bodies converted before forwarding, JSON responses rewritten, SSE streams transcoded **event by event** so streaming stays streaming. Off by default, routed by model prefix; upstream 4xx/5xx error bodies are never converted. |
| Diagnostics | `--dry-run` prints the effective routing, the **rendered** injection table, the model-resolution chain, the bucket/transform decision, the difficulty score and the upstream pool with no network I/O; `--doctor` adds DNS/TCP/TLS reachability, listen-port checks (free? on the WHATWG forbidden-port list?) and exits non-zero on problems. |
| Streaming | SSE is piped chunk by chunk, never buffered. Upstream 4xx bodies come back verbatim. |
| Operations | `/__llm_session_proxy__/status` and `/sessions`, **log-to-disk on by default** (`~/.lsp/logs`) with size/date rotation and 30-day archival, four-layer config merge (defaults < file < env < CLI). Auto-assigned listen ports (`listen.port: 0`) never land on a WHATWG forbidden port; a port you configure explicitly is respected and reported by `--doctor` instead. |
| Stability | A single malformed request cannot kill the process; uncaught errors land in the log file; **925 tests**, nine of them dedicated malformed-input and half-open-connection scenarios (illegal `Host`, control characters in the upstream reason phrase and headers, a malformed request line, oversized headers, a client that disconnects mid-body, an upstream that drops an idle keep-alive). |
| Language | Console output and log messages are **English by default**, switchable to Chinese with `--lang zh` / `PROXY_LANG=zh`. |

### Known gaps (stated plainly)

1. **No retry, no health check, no circuit breaker.** The upstream pool can *choose* between upstreams,
   but it cannot fall back on its own: a 429 or a 5xx is returned to the client as-is. Fallback and
   retry are v0.5 work.
2. **No machine-readable observability.** Human-readable log lines only: no metrics endpoint, no
   structured log mode, no trace export.
3. **The transform registry is a fixed list.** Five in-tree transforms, and no way to load one from a
   path. Still absent at the transform level: system-prompt *content* rewriting (protocol conversion
   moves system messages between shapes, it does not rewrite what they say).
4. **No caching and no cost accounting.** We can make the *upstream's* cache hit; we cannot report
   whether it did.
5. **Protocol conversion is lossy at the edges, by design.** Anthropic `thinking` / `signature` stream
   deltas are dropped when converting to chat; `messages ↔ responses` composes through chat.
6. **The difficulty scorer reads the request, not the task.** A three-word question in a 30 KB
   context scores as `hard`; a 40-line refactor with three files scores as `medium`. It is a
   *shape* heuristic, and it is documented as one.
7. **Copilot BYOK stays a client feature.** GitHub's own BYOK keeps the key in the client's keychain
   and bills the provider directly — the proxy cannot change that, so mixing Copilot-hosted models
   with your own keys is done here by **adding your own provider as an upstream**, not by asking
   Copilot to use your key.

---

## 2. What the neighbours teach us

The category splits into five families. We are deliberately in the smallest one.

| Project | Runtime | What it is | What it does better than us | What we take from it | What we deliberately skip |
| --- | --- | --- | --- | --- | --- |
| **[LiteLLM](https://github.com/BerriAI/litellm)** | Python | The default self-hosted gateway: 100+ providers, one OpenAI-shaped API | Provider breadth, virtual keys, budgets, team spend tracking, load balancing | The *shape* of the config surface; the lesson that one OpenAI-compatible endpoint is what clients actually want | Virtual keys, budgets, a database, an admin panel — all of it is multi-tenant SaaS machinery |
| **[claude-code-router](https://github.com/musistudio/claude-code-router)** | Node.js | Local router for Claude Code: buckets (`default` / `background` / `think` / `longContext`), a transformer plugin system, Anthropic↔OpenAI conversion | Protocol translation, rule/bucket routing, per-provider transformers, a Web UI | Router buckets and the transformer registry **as a config-driven concept**; `longContextThreshold`-style policy | Its plugin loading model, and its single-client focus |
| **[one-api](https://github.com/songquanpeng/one-api) / [new-api](https://github.com/Calcium-Ion/new-api)** | Go | Relay panel: multi-channel, quota, token billing, China-friendly | Channel pools, quota and billing, a management UI | Nothing structural — it is a service, we are a CLI | The whole billing/quota model |
| **[gpt-load](https://github.com/tbphp/gpt-load)** | Go | Key-pool + load balancer for upstream keys | Key rotation, weighted balancing across many keys | Key-pool rotation (v0.5, only if it stays file-based) | Databases, a Web admin |
| **[Portkey](https://github.com/Portkey-AI/gateway) / [Bifrost](https://github.com/maximhq/bifrost) / [Envoy AI Gateway](https://github.com/envoyproxy/ai-gateway)** | Node / Go / Envoy | Production gateways built for throughput, guardrails and governance | Measured low-single-digit-millisecond overhead, guardrail chains, circuit breaking, Kubernetes-native policy | Guardrail primitive design; passive health checks; the discipline of publishing a benchmark harness | Envoy/K8s deployment weight, and chasing microsecond benchmarks |
| **[Cloudflare](https://developers.cloudflare.com/ai-gateway/) / [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) / Helicone / Langfuse** | hosted | Managed gateways and observability platforms | Zero ops, DLP/PII scanning, cost dashboards, trace UIs | The metric set worth exposing (TTFT, added latency, token counts, prefix reuse) | Sending prompts anywhere |

### Three lessons we take seriously

**1. Published gateway benchmarks are mostly measured against a mock upstream, and the spread is
five orders of magnitude.** In 2026 the numbers ranged from a vendor claim of ~11 µs of overhead
(Bifrost, Bifrost-only stress test, mock upstream, upstream response time excluded) to ~40 ms median
for LiteLLM's Python proxy with logging callbacks enabled. An independent head-to-head (checked-in
harness, n=5000, local deterministic mock, non-streaming, callbacks off) reported p99 added latency
of ~0.7 ms for LiteLLM's Rust rewrite, ~2.3 ms for Portkey and ~4.5 ms for Bifrost, against ~257.7 ms
for LiteLLM Python v1. The one published run that measured against a **real** upstream was Envoy AI
Gateway's July 2026 test: roughly 2 ms of added overhead with streaming against live GPU inference,
inside a 20 ms budget.

Conclusion for us: **publish the harness, state the methodology, and stop arguing about
microseconds.** Provider TTFT runs 500 ms–5 s, so gateway overhead is a rounding error. Section 4
therefore sets targets we can actually measure and reproduce, and section 7 says how.

**2. Feature breadth is not winnable, and it is not the point.** LiteLLM has 100+ provider
integrations and a team behind it. We have a config file and, since v0.3.0, a small pool of
upstreams we can route between. Our advantage has to be **fidelity on the small thing**: bind to the
conversation correctly, keep the upstream's prompt cache warm, inject exactly the headers the
upstream wants, and pass bytes through untouched.

**3. Supply-chain surface is a feature.** LiteLLM published twelve advisories in 2026 — including a
pre-auth SQL injection and an unauthenticated RCE that reached CISA's known-exploited list (both
fixed in current stable), and two PyPI releases that briefly shipped credential-stealing code. That
is the cost of being a network-exposed service with a database and an admin panel. Our answer is
structural, not procedural: **zero runtime dependencies, loopback-only by default, no admin panel, no
inbound authentication to get wrong, and nothing to patch.** Any roadmap item that would erode that
gets rejected, however popular the feature is.

---

## 3. Constraints and non-goals

**Non-goals, permanently:**

- ❌ Multi-tenant virtual keys, quotas or billing. That is one-api/new-api/LiteLLM territory.
- ❌ A model server. We do not run inference; vLLM and Ollama already do.
- ❌ A database. Sessions and prices live in memory or small files.
- ❌ An admin UI that needs a build step. If we ship a dashboard, it is hand-written HTML/JS served
  by the same Node process.
- ❌ Binding to `0.0.0.0` by default. The proxy forwards your API key; that stays a local tool.
- ❌ Non-Node runtimes or a Rust rewrite. Startup time and `npx` are the product.
- ❌ Chasing microsecond headlines. We optimise for "not the bottleneck", with a published harness.

**Constraints:**

- Zero runtime dependencies, forever. HTTP/2, TLS, metrics text format, JSON logging and a dashboard
  are all reachable with Node built-ins; anything that is not, does not ship.
- Single process, single port.
- Every new flag ships with: tests, both READMEs, both documentation-site pages, and a line on this
  roadmap.

---

## 4. Performance targets

Measured by the harness in section 7, on a 4-vCPU / 16 GB Linux VM, against a **local mock upstream**
unless stated otherwise. Methodology is published with the numbers, because the numbers are
meaningless without it.

| Metric | v0.2 target | v1.0 target |
| --- | --- | --- |
| Added latency, non-streaming (p50) | ≤ 1.0 ms | ≤ 0.6 ms |
| Added latency, non-streaming (p99) | ≤ 5 ms | ≤ 2.5 ms |
| Added time-to-first-byte, streaming (p95) | ≤ 2 ms | ≤ 1 ms |
| Throughput, 100 concurrent connections | ≥ 1,200 RPS, 0 errors | ≥ 2,500 RPS, 0 errors |
| Resident memory, 1,000 open streams | < 90 MB | < 60 MB |
| Bytes altered in an SSE pass-through | 0 (byte-for-byte) | 0 |
| Process exits under the fuzz corpus | 0 | 0 |
| Cold start: `npx` → first served request | < 2.0 s | < 1.5 s |

Peer reference points, for calibration only: the independent 2026 head-to-head band was ~0.7–4.5 ms
p99 for the serious gateways, against a mock. Being inside 5 ms p99 puts us in the band; being
*zero-dependency and local* is what we are actually selling.

---

## 5. Milestones

### v0.2 — Correctness and protocol reach <sub>(the "one client, every model" release)</sub>

The single highest-value feature on this page. Today a client's protocol decides which models it can
reach; after v0.2 that stops being true.

**Delivered in stages.** v0.2.0 took the two items that need no new architecture. v0.2.1 (both items
below, ticked) added the routing layer that the translators hang off; v0.2.2 delivered the translation
itself. Split that way because a bidirectional SSE transcoder is the riskiest change on this page, and
bisecting it apart from routing changes is far easier than bisecting both at once.

- [x] **Protocol translation:** Anthropic Messages ↔ OpenAI Chat Completions ↔ OpenAI Responses, both
      directions, streaming included, as three peer endpoints rather than one lucky one.
      <sub>**v0.2.2.** `src/protocol.js` (detection + routing), `src/converters.js` (request bodies),
      `src/replies.js` (JSON responses), `src/stream.js` (SSE transcoding). The SSE canonical form is
      chat's `chat.completion.chunk` — the finest delta granularity of the three — so only one state
      machine per side is needed. Conversion runs **last** in the pipeline, after transforms and
      injection; `accept-encoding: identity` is forced upstream when converting, because gzip cannot
      be parsed on SSE event boundaries.</sub>
- [x] **Field normalisation inside the translation:** `thinking` ↔ `reasoning_effort`, `max_tokens` ↔
      `max_completion_tokens`, tool-call shapes, `cache_control` handling, stop-sequence types.
      <sub>**v0.2.2.** Fixed budget table low=1024 / medium=8192 / high=16384, inverse by threshold.
      Everything without an equivalent (`cache_control`, `response_format`, …) is dropped **by name**
      into a `dropped` list; Anthropic's required `max_tokens` defaults to a logged 4096 rather than a
      400. Error bodies (4xx/5xx) are exempt from conversion by design.</sub>
- [x] **Transformer registry:** named, config-selectable per-upstream transforms (the
      claude-code-router model), implemented in-tree.
      <sub>**v0.2.1.** `src/transformers.js` ships five — `noop`, `drop-fields`, `drop-empty-fields`,
      `rename-fields`, `clamp-max-tokens` — each declaring a `phase` so the response-side translators
      have a slot to land in for v0.2.2. **The "opt in to plugin loading" sketched here was dropped on
      purpose:** letting a config file point at code is a disproportionate security surface for a tool
      whose whole pitch is "zero dependencies, loopback only". An unknown name is a startup error
      instead of a silent no-op.</sub>
- [x] **Router buckets:** `default` / `background` / `think` / `longContext` with a threshold, plus
      rule matching (path prefix, model prefix, body field, request size). Config-only.
      <sub>**v0.2.1.** `src/router.js`, plus `--router` / `--transformer` / `--no-router` and `Router` /
      `Transformers` blocks in `--dry-run` and `--doctor`. Thresholds are **bytes, not tokens**: a
      token estimate would mean shipping a tokenizer, and a byte count is a figure you can actually
      tune. `router.enabled` defaults to `false` and a config test plus an end-to-end proxy test pin
      that upgrading changes nothing. **The "user-supplied JS router module" sketched here was dropped
      for the same reason as the plugin loader.**</sub>
- [x] **Fix the `model.map` gap:** ship a curated default map for common upstreams, warn loudly when
      a `proxy-`-prefixed alias resolves to nothing, and align the README with the real behaviour.
      <sub>**v0.2.0.** `src/models.js` holds 27 aliases; the warning names the entry to add and fires
      once per alias per process; both READMEs now document the resolution order and the merge
      semantics. Fixing this exposed a latent aliasing bug — `buildConfig` mutated `DEFAULT_CONFIG`
      in place through shallow copies, so a caller editing its own config corrupted the process-wide
      default. Fixed with a deep copy and pinned by a test.</sub>
- [x] **`--dry-run` / `doctor`:** validate config, resolve an example model, print the effective
      routing and injection table, check upstream reachability, exit non-zero on problems.
      <sub>**v0.2.0.** `src/doctor.js`. Stops at the transport layer on purpose — no HTTP request, no
      credentials — so a doctor run cannot burn rate-limit quota or leak a key.</sub>

### v0.3 — Difficulty routing and upstream reach <sub>(the "one client, every model, every key" release)</sub>

Two orthogonal axes. The first decides **which model** a request should use; the second decides
**where the request goes**. Neither one is optional for the other, so they ship together.

- [x] **Difficulty scorer:** a local, deterministic, in-tree scorer that grades a request by
      *shape* and maps it onto named bands.
      <sub>**v0.3.0.** `src/scoring.js` — a named registry (`builtin-complexity`) with nine weighted
      signals: bytes 22, turns 12, code blocks 15, diff lines 13, tools 8, system 8, files 8,
      reasoning 8, max tokens 6. Bytes use a log scale and anything under 512 bytes scores 0; diff
      lines exclude `+++` / `---` file headers. Bands default to `easy ≤ 30` / `medium ≤ 60` /
      `hard ≤ 100`. The router matches on a band like any other condition. **Deliberately not a
      model call and deliberately not a plugin loader:** a network round-trip per request would
      defeat the purpose, and letting a config file point at code would break the zero-dependency,
      loopback-only security story. The scorer reads the request, not the task — a short question in
      a huge context still scores high.</sub>
- [x] **Upstream pool:** several upstreams in one process, each with its own base URL, endpoint
      paths, wire protocol and credential source.
      <sub>**v0.3.0.** `src/upstreams.js` — provider types `openai` / `anthropic` / `gemini` /
      `copilot` / `custom`. Selection order: the bucket's explicit `upstream` → the model-name
      prefix table → the pool default → the legacy single `upstream` config. Matching uses **both**
      the client-facing model name and the resolved one, because alias rewriting strips the
      `proxy-` prefix. Credentials are resolved per provider (env → command → stored file) and the
      resolved value never reaches the log.</sub>
- [x] **GitHub Copilot as an upstream:** Copilot-hosted models, authenticated the official way.
      <sub>**v0.3.0, direct by default since v0.3.1.** `src/copilot.js` — by default the GitHub token is sent **directly** to
      `api.githubcopilot.com` as the Bearer credential, the same shortcut OMP takes; the exchange at
      `copilot_internal/v2/token` (which returns 403 for `gh` CLI OAuth tokens) is opt-in via
      `auth.tokenMode: "session"`, and that session token then lives in memory only and refreshes
      five minutes before expiry. The GitHub token comes from `COPILOT_GITHUB_TOKEN` →
      `GH_TOKEN` → `GITHUB_TOKEN` → the `gh` CLI → the archived credential file → the device flow,
      i.e. the official chain rather than a private scrape. The device flow (GitHub's OAuth 2.0
      Device Authorization Grant) is **off by default** and only runs when the provider sets
      `auth.deviceFlow` — a login that needs a human must never start behind your back; the code and
      the verification URL are printed, and the resulting token is archived to
      `~/.lsp/copilot-credentials.json` (mode 0600) so it happens once. `--login-copilot` runs that
      flow standalone. `ghp_` classic PATs are explicitly **not** supported (GitHub deprecated them
      for Copilot); `github_pat_` / `ghu_` / `gho_` / `ghs_` are. `Copilot-Integration-Id` is pinned
      to `copilot-developer-cli` and `X-GitHub-Api-Version` to `2026-08-01`; `--doctor` verifies a
      Copilot provider with one read-only `GET /models`.</sub>
- [x] **Gemini as a fourth wire protocol:** the native `generateContent` shape, not an OpenAI-shaped
      imitation.
      <sub>**v0.3.0.** `src/converters.js`, `src/replies.js` and `src/stream.js` grow from six
      conversion directions to twelve (six direct, six through chat as the pivot). Gemini carries the
      model name and the streaming flag **in the path** (`/v1beta/models/{model}:streamGenerateContent?alt=sse`),
      which is why the proxy captures both before conversion moves them. Auth is
      `x-goog-api-key`, with no `Bearer` prefix.</sub>

### v0.4 — Observability and control

- [ ] **Prometheus text-format `/metrics`** on the local prefix: request counts by upstream/status,
      added-latency histograms, session table size, cache-reuse counters, bytes in/out.
- [ ] **Structured logging:** `--log-format json` with stable field names, one JSON object per
      request, so logs are greppable and shippable without a parser.
- [ ] **OTLP/JSON export** over HTTP to a user-configured endpoint (JSON encoding, not protobuf, to
      stay dependency-free). Off by default.
- [ ] **Session and prefix inspector:** expose the stable-prefix hash per session and estimate
      whether the upstream's prompt cache was reusable — the metric that justifies this whole tool.
- [ ] **Token and cost accounting** per session/model/upstream, priced from a user-supplied price
      table. We will not hardcode vendor prices; they change too often.
- [ ] **Zero-build dashboard:** one hand-written HTML page served locally, reading the local
      endpoints. No bundler, no framework, no npm install.

### v0.5 — Reliability under real upstreams

- [ ] **Weighted / priority selection inside the pool** — the pool chooses by rule today, not by
      observed health.
- [ ] **Fallback and retry:** retry on 429/5xx/timeout with jitter and a hard attempt cap, never
      retrying a request whose streamed body was already partially delivered. (Production telemetry
      surveys in 2026 attributed roughly a third of LLM API errors to rate limiting — this is where
      most of the real-world availability comes from.)
- [ ] **Circuit breaker and passive health checks:** trip on consecutive failures, probe back with a
      single request, and surface breaker state on `/status`.
- [ ] **Separated timeouts and a stream idle watchdog:** connect / headers / idle / total, with a
      watchdog that aborts a stalled stream with a clear 504 instead of hanging forever.
- [ ] **Graceful drain:** on `SIGTERM`, stop accepting, finish in-flight SSE, then exit.
- [ ] **Optional session persistence:** a small append-only file so a restart does not break
      conversation binding. Off by default.

### v0.6 — Safety and hygiene

- [ ] **Secret hygiene in logs:** never log credential values (today we log presence only — keep it
      that way), plus a redaction pass for anything that looks like a key.
- [ ] **Guardrails:** regex-based input/output masking and per-upstream header/body allowlists.
- [ ] **Config schema validation** with precise, line-referenced errors and a documented schema.
- [ ] **`--check-config` in CI:** the same validation as a standalone exit code, for people who
      version their proxy config.

### v1.0 — Distribution and guarantees

- [ ] **Single-file binaries** (Node SEA) for Linux/macOS/Windows, plus a distroless Docker image,
      Homebrew and Scoop taps. `npx` stays the primary path.
- [ ] **Client compatibility matrix** with a checked-in fixture per client: Trae, Cursor, Cline,
      Continue, Aider, Claude Code, OpenCode, Zed, Roo.
- [ ] **Contract tests per protocol** using golden SSE fixtures, including malformed and truncated
      streams.
- [ ] **Config migration tool** (`--migrate-config`) so upgrades never strand a working setup.
- [ ] **Semver guarantee from 1.0:** no breaking config change without a migration path.

---

## 6. Priority

Ranked by (reach × differentiation) ÷ effort.

| Item | Reach | Differentiation | Effort | Priority |
| --- | --- | --- | --- | --- |
| Protocol translation | Very high | High | High | ✅ shipped in v0.2.2 |
| `model.map` default + docs fix | High | Low | Very low | ✅ shipped in v0.2.0 |
| Difficulty scoring | High | **High** | Medium | ✅ shipped in v0.3.0 |
| Upstream pool + Copilot / BYOK mixing | High | **High** | High | ✅ shipped in v0.3.0 |
| `/metrics` + JSON logs | High | Low | Low | **P1** |
| Doctor / dry-run | High | Medium | Low | ✅ shipped in v0.2.0 |
| Transformer registry + router buckets | High | Medium | Medium | ✅ shipped in v0.2.1 |
| Session & prompt-cache inspector | Medium | **Very high** | Medium | **P1** |
| Fallback / retry / breaker | High | Low | Medium | **P2** |
| Stream idle watchdog | Medium | Medium | Low | **P2** |
| Dashboard | Medium | Low | Medium | **P3** |
| Cost accounting | Medium | Low | Medium | **P3** |
| Single-file binaries | Low | Low | High | **P3** |

---

## 7. How we measure

`scripts/bench.mjs` (to be added later in v0.4.x, once the translation layer stops moving) will:

1. start a deterministic mock upstream with configurable latency and streaming,
2. replay a fixed request corpus at a stated concurrency against both the upstream directly and
   through the proxy,
3. report added latency by percentile, TTFT delta, throughput, RSS, error rate and SSE byte
   equality,
4. write `bench/results/<version>.json` including CPU model, Node version, OS and the exact flags.

Rules for using it:

- Never compare against a mock without saying so, and never quote a number without the run's
  metadata next to it.
- A change that improves a benchmark but breaks a byte-equality test is a regression, not a win.
- Benchmarks are advisory in CI (tracked over time), blocking only on the stability corpus.

---

## 8. Engineering principles

1. **Zero runtime dependencies.** A feature that needs one is either re-implemented or rejected.
2. **Never buffer what can be piped.**
3. **Keep policy evaluation off the critical path.** Guardrails and accounting run alongside the
   stream, and a slow policy must never delay a token.
4. **Fail soft in the request path, fail loud in the log.** A single bad request becomes a 4xx; a
   bug becomes a log line, not an exit.
5. **Prefer deleting a config knob to adding one.** Defaults should be right for the common case.
6. **Documentation is part of the definition of done:** both READMEs, both site pages, this roadmap.
7. **Loopback by default.** Anything that makes the proxy reachable from the network is opt-in and
   documented as a risk.

---

## 9. Cadence and versioning

- `v0.x` may change the config shape; each release documents what moved.
- A milestone may span several minor versions when its parts have different risk profiles. v0.2 is
  the first case: v0.2.0 shipped the map gap and the doctor, v0.2.1 shipped routing, and v0.2.2
  shipped the protocol translation. Each minor version is independently installable and independently
  verified.
- v0.3.0 shipped as one release because the two axes it introduces are useless apart: a difficulty
  band only helps if something can route on it, and an upstream pool only pays off if traffic
  reaches it. The milestone numbers after v0.3 were **renumbered** (v0.4 is now observability,
  v0.5 reliability, v0.6 safety) to keep one milestone per release train.
- From `v1.0`: semver. Breaking config changes require `--migrate-config`.
- Releases go out through `.github/workflows/publish.yml` on a `v*` tag, with the pack check and the
  end-to-end install verification run first.

---

## 10. Not on the roadmap (and why)

| Idea | Why not |
| --- | --- |
| Virtual keys, quotas, billing | Multi-tenant SaaS machinery; one-api/new-api/LiteLLM already do it, and a database is a liability on a developer machine. |
| Running models locally | vLLM, llama.cpp and Ollama exist and are better at it. |
| A hosted version | The value here is that your prompts and keys stay on your machine. |
| A plugin marketplace | Arbitrary code loading from third parties is exactly the supply-chain risk we are avoiding. |
| Kubernetes operator / sidecar | The target is a laptop. |
| A Rust/Go rewrite for benchmark headlines | `npx` startup and zero-install are worth more than 0.5 ms nobody can perceive. |
