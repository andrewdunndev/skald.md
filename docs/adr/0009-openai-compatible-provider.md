# ADR 0009: OpenAI-compatible provider for self-hosted models

- Status: Proposed (direction set; feature not yet built)
- Date: 2026-06-22
- Deciders: Andrew Dunn

## Context

Skald is direct-only ([ADR 0001](0001-direct-mode-over-cloudflare-worker.md)):
the plugin calls the model straight from Obsidian's renderer, with no
backend. Today it supports two providers, Anthropic and OpenRouter — but
both speak **Anthropic's wire format**. OpenRouter works only because the
transport points at OpenRouter's *Anthropic-compatible* `/v1/messages`
endpoint; the internal `ChatRequest`, the SSE event model
(`message_start` / `content_block_delta` / …), and the parser are all
Anthropic-shaped. **There is no OpenAI-format code path in the plugin.**

We want to run our own models on self-hosted GPUs (built alongside the
othala/carmine work). The universal interface for self-hosting is the
**OpenAI Chat Completions API** — vLLM, Ollama, LM Studio, llama.cpp, and
TGI all speak it; almost nobody self-hosts Anthropic's wire format. This
is the *direct-tier* expansion to local models reachable as a plain HTTP
endpoint, distinct from (and reachable sooner than) the full persistent
[agent-host in ADR 0008](0008-agent-host-tier.md).

Two architectures were considered:

- **A — endpoint speaks Anthropic.** Front the model with a shim
  (e.g. LiteLLM exposing `/v1/messages`) so the plugin reuses its
  existing identity path. Small plugin change, but adds a translation
  hop to every deployment and only serves the niche of Anthropic-wire
  endpoints.
- **B — plugin speaks OpenAI.** Add a native OpenAI-compatible provider;
  the plugin owns the Anthropic↔OpenAI translation. More plugin work
  (a real adapter, since none exists), but it unlocks the entire
  self-hosting ecosystem and keeps the user's serving stack simple
  (no translation layer).

## Decision

Adopt **Architecture B**: a first-class **OpenAI-compatible provider**.
The plugin translates between its Anthropic-shaped internals and the
OpenAI Chat Completions API; a self-hosted endpoint only needs to be
standard OpenAI-compatible.

Providers are **coequal and independently configured**, and the user
**switches** between them — one active provider at a time (not
simultaneous mixing). This is already the settings shape (per-provider
configuration: a secret-storage key for each provider, plus the new
`openaiBaseUrl` and `openaiModel`), so switching is
lossless — flipping the active provider never discards another's config.
Per-provider [capability gating](../security-model.md) (one exhaustive
switch in `provider-capabilities.ts`) makes the switch capability-correct
automatically: Anthropic-only features (prompt caching, citations, server
tools, extended thinking) turn off on a self-hosted endpoint and back on
for Claude, with no user management.

Switching is a **two-level provider → model control in the chat header**,
realized as a **single grouped menu**: one tap opens a list with
providers as section headers and their models beneath; tapping a model
sets provider + model together. It remembers the last model per provider.
This keeps the switch one gesture on a narrow phone header while still
reading as two levels.

A self-hosted privacy benefit falls out of this: switching to the
self-hosted endpoint keeps vault content on the user's network — Claude
for hard or agentic work, local for routine or sensitive notes.

### Serving-side contract (the requirements an endpoint must meet)

This is the contract the self-hosted side (e.g. Envoy → vLLM/Ollama on
carmine) must satisfy. It is recorded here so the plugin and the serving
deployment share one source of truth.

1. **CORS is mandatory — the #1 silent failure.** Streaming uses browser
   `fetch` from the renderer, which enforces CORS (the reason the
   Anthropic path carries `anthropic-dangerous-direct-browser-access`).
   The endpoint or its edge must return `Access-Control-Allow-Origin` for
   Obsidian origins and answer preflight `OPTIONS`: desktop
   `app://obsidian.md`; mobile (Capacitor) `capacitor://localhost` /
   `http://localhost` (verify on-device); allow `POST, OPTIONS` and
   headers `Authorization, Content-Type`.
2. **Unbuffered streaming, long timeouts.** SSE must pass through
   unbuffered; disable per-route response buffering and the default
   request timeout at the edge (Envoy's 15s would kill generations). The
   plugin enforces a 60s *idle* timeout, so the server must emit a token
   within 60s of the previous one.
3. **Auth is bearer over TLS, not mTLS.** The plugin can send
   `Authorization: Bearer <token>` but cannot present a client
   certificate. Client→edge auth must be a bearer token; reserve mTLS for
   the internal hop.
4. **Edge cert must be device-trusted.** iOS will not trust a private CA
   without a provisioning profile, so the client→edge cert must be
   publicly trusted (the LE edge, not the private mesh CA).
5. **Endpoints.** `POST /v1/chat/completions` (streaming) is required;
   `GET /v1/models` is a nice-to-have for the model picker; a health
   route helps a settings "test connection" button. The served model
   name must match what the user enters.
6. **Escape hatch.** If CORS is intractable on some deployment, the
   plugin can fall back to non-streaming via Obsidian's `requestUrl`
   (bypasses CORS, loses live streaming). Not the default; it exists.

### Reference deployment (as built — `llm.dunn.dev`, 2026-06-22)

The first concrete endpoint Skald integrates against. Topology:
Skald → `https://llm.dunn.dev/v1` (envoy SNI → caddy → LiteLLM) → Ollama.
Skald goes **direct to LiteLLM**, not through the human chat UI at
`chat.dunn.dev` (Open WebUI).

- **Endpoint:** `https://llm.dunn.dev/v1`, OpenAI-compatible (LiteLLM).
  Edge is restricted to `/v1/*` + `/health`; `/ui` and `/key/*` are 404.
- **Auth:** `Authorization: Bearer sk-...` — a LiteLLM *virtual key*
  (operator-issued). Bearer is the only gate; no OIDC, no mTLS. Device-
  trusted LE cert on its own FQDN (iOS trusts out of the box) — the
  reason the API is *not* behind the private step-ca mesh.
- **Model:** request the LiteLLM **alias** (`qwen2.5-14b`), not the Ollama
  tag (`qwen2.5:14b-instruct`); `GET /v1/models` returns aliases. Default
  Qwen2.5-14B-Instruct (strong tool-calling).
- **Streaming:** SSE, unbuffered (`flush_interval -1`).
- **Tool-calls — the non-obvious one:** LiteLLM **consolidates a tool
  call into a single chunk** and drops the preamble text. The call
  arrives *whole*, not as incremental `arguments` fragments. (See the
  Consequences note — the robust accumulator handles this for free.)
- **Timeouts:** cold model load 10–30s; server `request_timeout` 600s.
  Expect a possible first-request 502 during LiteLLM cold-start.
- **Metering:** per-virtual-key spend tracked server-side; Skald sends
  nothing extra — identity is the key it holds.

This is *one* deployment; the generic contract above still governs any
self-hoster's endpoint (the public plugin's broader claim).

## Consequences

- **A real OpenAI adapter is net-new.** Request building (Anthropic
  `ChatRequest` → OpenAI messages/tools/system) and stream translation
  (OpenAI `choices[].delta` chunks → the internal Anthropic-shaped
  events) must be written; there is no OpenAI path to reuse. Roughly a
  medium effort.
- **Utility tier is now provider-agnostic (done).** `rerank.ts` was
  hardcoded to `api.anthropic.com` (and `read.ts` wrongly gated rerank on
  the prompt-caching capability, disabling it on OpenRouter). Landed: a
  shared `utility-call.ts` `utilityComplete()` that rerank, memory-upkeep,
  and capture all dispatch through. Adding `'openai'` is now one new
  `case` there, not a fourth copy.
- **Tool-call streaming: accumulate by index (handles both shapes).** The
  OpenAI stream adapter must reassemble `tool_calls` by their `index`
  across `choices[].delta` chunks. OpenAI / vLLM-direct / Ollama-direct
  stream tool-call `arguments` incrementally; LiteLLM (the reference
  deployment) delivers the call *whole in one chunk*. An accumulator-by-
  index handles the incremental case and treats the whole-chunk case as
  the trivial single-fragment case — so one robust path gives both general
  OpenAI compatibility and LiteLLM compatibility. Note LiteLLM also drops
  the assistant preamble text on a tool turn; do not depend on it.
- **Cold-start timeouts need provider-aware handling.** The plugin's
  current `REQUEST_TIMEOUT_MS` (30s) is too tight for a self-hosted cold
  model load (10–30s before first token) and a possible cold-start 502.
  The OpenAI provider needs a longer (or disabled) request timeout for the
  initial response and a retry-once on a first-request 502. The 60s
  *idle* timeout is fine once tokens flow.
- **Feature degradation is honest and centralized.** Caching, citations,
  server tools, and extended thinking are off on OpenAI-compatible
  endpoints, gated in one place; the experience shifts but does not
  break.
- **Switch, not mix.** The two-tier cascade ([ADR 0005](0005-model-cascade.md))
  stays *within* the active provider. Running the reasoning tier on Claude
  while the cheap tier runs on a local model simultaneously is a larger,
  separate change and is explicitly deferred.
- **New settings + header control.** Independent `openai*` fields, and
  the grouped header switcher (which also benefits the existing
  Anthropic/OpenRouter switch).

## Open questions

- Tool-calling reliability for an agentic vault client on open models is
  model-dependent (much weaker than Claude); model choice matters more
  than the server (vLLM vs Ollama). Validate the tool loop per model.
- Model discovery: populate the picker from `/v1/models`, or free-text?
- Per-conversation provider memory vs a single global active provider.
- Exact mobile (Capacitor) origin string for CORS. Desktop
  (`app://obsidian.md`) is covered; the reference edge allows
  `capacitor://localhost` + `http://localhost` (the standard Capacitor
  cases). The definitive on-device origin must be confirmed during the
  device human-test — if Obsidian iOS uses a different scheme it is
  CORS-blocked silently, and the operator adds it to the edge.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0005: Two-tier model cascade](0005-model-cascade.md)
- [ADR 0008: Agent-host tier for the heavy path](0008-agent-host-tier.md)
