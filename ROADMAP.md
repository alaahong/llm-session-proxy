# Roadmap

`llm-session-proxy` is a **zero-dependency, local, single-process reverse proxy** for LLM APIs. It
exists to fix one thing well: clients that cannot send the headers an upstream demands. Everything
below has to fit that shape.

- **Scope:** one developer machine, one upstream (a few at v0.4+), one process.
- **Non-negotiable:** `dependencies` in `package.json` stays empty. Features that would need a
  library get re-implemented on Node built-ins, or they do not ship.
- **Status:** v0.1.x — the session/header injection core works and is hardened. Everything else is
  on this page.

---

## 1. Where it stands today

### Working (v0.2.0)

| Area | What ships now |
| --- | --- |
| Sessions | Three-tier resolution: explicit client identifier → content fingerprint (`system` + first user message) → one-off random. Stable per conversation, so upstream prompt caching works. |
| Injection | Arbitrary request headers and body fields, templated (`{{session.id}}`, `{{uuid}}`, `{{env.HOME}}`, …), with dot-path support and an `overwrite` switch. |
| Rewriting | Model aliases (exact map + prefix stripping, composable) and request paths (regex rules). A curated OpenCode Go alias table now ships **in the box**, so the `proxy-` prefix the README prescribes resolves without a config file; an alias that strips down to something unmapped is reported by name instead of being forwarded silently. |
| Diagnostics | `--dry-run` prints the effective routing, the **rendered** injection table and the model-resolution chain with no network I/O; `--doctor` adds DNS/TCP/TLS reachability and listen-port checks and exits non-zero on problems. |
| Streaming | SSE is piped chunk by chunk, never buffered. Upstream 4xx bodies come back verbatim. |
| Operations | `/__llm_session_proxy__/status` and `/sessions`, **log-to-disk on by default** (`~/.lsp/logs`) with size/date rotation and 30-day archival, four-layer config merge (defaults < file < env < CLI). |
| Stability | A single malformed request cannot kill the process; uncaught errors land in the log file; 178 tests including a 43-scenario malformed-input corpus. |
| Language | Console output and log messages are **English by default**, switchable to Chinese with `--lang zh` / `PROXY_LANG=zh`. |

### Known gaps (stated plainly)

1. **No protocol translation.** The client's protocol decides which models are reachable. A client
   that only speaks Anthropic Messages cannot use `/chat/completions`-only models, and vice versa.
   This is the remaining half of v0.2.
2. **One upstream, no fallback.** No retry, no health check, no circuit breaker.
3. **No machine-readable observability.** Human-readable log lines only: no metrics endpoint, no
   structured log mode, no trace export.
4. **No transformation beyond injection.** No system-prompt rewriting, no tool-call normalisation,
   no reasoning-field mapping (Anthropic `thinking` ↔ OpenAI `reasoning_effort`).
5. **No caching and no cost accounting.** We can make the *upstream's* cache hit; we cannot report
   whether it did.

---

## 2. What the neighbours teach us

The category splits into five families. We are deliberately in the smallest one.

| Project | Runtime | What it is | What it does better than us | What we take from it | What we deliberately skip |
| --- | --- | --- | --- | --- | --- |
| **[LiteLLM](https://github.com/BerriAI/litellm)** | Python | The default self-hosted gateway: 100+ providers, one OpenAI-shaped API | Provider breadth, virtual keys, budgets, team spend tracking, load balancing | The *shape* of the config surface; the lesson that one OpenAI-compatible endpoint is what clients actually want | Virtual keys, budgets, a database, an admin panel — all of it is multi-tenant SaaS machinery |
| **[claude-code-router](https://github.com/musistudio/claude-code-router)** | Node.js | Local router for Claude Code: buckets (`default` / `background` / `think` / `longContext`), a transformer plugin system, Anthropic↔OpenAI conversion | Protocol translation, rule/bucket routing, per-provider transformers, a Web UI | Router buckets and the transformer registry **as a config-driven concept**; `longContextThreshold`-style policy | Its plugin loading model, and its single-client focus |
| **[one-api](https://github.com/songquanpeng/one-api) / [new-api](https://github.com/Calcium-Ion/new-api)** | Go | Relay panel: multi-channel, quota, token billing, China-friendly | Channel pools, quota and billing, a management UI | Nothing structural — it is a service, we are a CLI | The whole billing/quota model |
| **[gpt-load](https://github.com/tbphp/gpt-load)** | Go | Key-pool + load balancer for upstream keys | Key rotation, weighted balancing across many keys | Key-pool rotation (v0.4, only if it stays file-based) | Databases, a Web admin |
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
integrations and a team behind it. We have one upstream per process and a config file. Our advantage
has to be **fidelity on the small thing**: bind to the conversation correctly, keep the upstream's
prompt cache warm, inject exactly the headers the upstream wants, and pass bytes through untouched.

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

**Delivered in stages.** v0.2.0 (ticked below) took the two items that need no new architecture.
v0.2.1 adds the routing layer that the translators hang off; v0.2.2 delivers the translation itself.
Split that way because a bidirectional SSE transcoder is the riskiest change on this page, and
bisecting it apart from routing changes is far easier than bisecting both at once.

- [ ] **Protocol translation:** Anthropic Messages ↔ OpenAI Chat Completions ↔ OpenAI Responses, both
      directions, streaming included, as three peer endpoints rather than one lucky one.
      <sub>→ v0.2.2</sub>
- [ ] **Field normalisation inside the translation:** `thinking` ↔ `reasoning_effort`, `max_tokens` ↔
      `max_completion_tokens`, tool-call shapes, `cache_control` handling, stop-sequence types.
      <sub>→ v0.2.2</sub>
- [ ] **Transformer registry:** named, config-selectable per-upstream transforms (the
      claude-code-router model), implemented in-tree — no plugin loading from arbitrary paths unless
      the user explicitly opts in.
      <sub>→ v0.2.1. It is the host the translators plug into, so it lands first.</sub>
- [ ] **Router buckets:** `default` / `background` / `think` / `longContext` with a threshold, plus
      simple rule matching (path, model prefix, body field). Config-only; a user-supplied JS router
      module may be pointed at explicitly.
      <sub>→ v0.2.1</sub>
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

### v0.3 — Observability and control

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

### v0.4 — Reliability under real upstreams

- [ ] **Multiple upstreams** with priority/weighted selection.
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

### v0.5 — Safety and hygiene

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
| Protocol translation | Very high | High | High | **P0** — next up, v0.2.2 |
| `model.map` default + docs fix | High | Low | Very low | ✅ shipped in v0.2.0 |
| `/metrics` + JSON logs | High | Low | Low | **P1** |
| Doctor / dry-run | High | Medium | Low | ✅ shipped in v0.2.0 |
| Transformer registry + router buckets | High | Medium | Medium | **P0 for v0.2.1** — unblocks translation |
| Session & prompt-cache inspector | Medium | **Very high** | Medium | **P1** |
| Fallback / retry / breaker | High | Low | Medium | **P2** |
| Stream idle watchdog | Medium | Medium | Low | **P2** |
| Dashboard | Medium | Low | Medium | **P3** |
| Cost accounting | Medium | Low | Medium | **P3** |
| Single-file binaries | Low | Low | High | **P3** |

---

## 7. How we measure

`scripts/bench.mjs` (to be added later in v0.2.x, once the translation layer stops moving) will:

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
  the first case: v0.2.0 shipped the map gap and the doctor, v0.2.1 will ship routing, v0.2.2 the
  protocol translation. Each minor version is independently installable and independently verified.
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
