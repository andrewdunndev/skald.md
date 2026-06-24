# Architecture

Skald is a **direct-only** Obsidian plugin: it talks straight from your device to
a model provider using **your** API key. There is no Skald-operated backend
([ADR 0001](adr/0001-direct-mode-over-cloudflare-worker.md)). This page orients a
reviewer — the multi-API provider model, the self-hosted path, the trust
boundaries, and the test strategy.

## Multi-API and self-hosted, at a glance

```mermaid
flowchart TB
  subgraph DEVICE["Your device — Obsidian (iPhone / iPad / desktop)"]
    VAULT[("Vault + data.json<br/>your API key, on-device")]
    SKALD["Skald plugin<br/>direct-only · no backend"]
    VAULT --- SKALD
  end

  SKALD -->|"internal: Anthropic wire format"| PROV{{"provider router"}}
  PROV -->|anthropic| ANTH["api.anthropic.com<br/>your Anthropic key"]
  PROV -->|openrouter| OR["openrouter.ai<br/>/v1/messages"]
  PROV -->|"openai-compatible<br/>(translated)"| OAI(["OpenAI /v1 endpoint"])

  OAI -. "metered token" .-> OPENAI["api.openai.com"]
  OAI == "no external token" ==> GW

  subgraph SELFHOST["Self-hosted — your GPUs · zero external token"]
    GW["llm.dunn.dev<br/>LiteLLM gateway · virtual key"]
    GW --> CHAT["Ollama / vLLM<br/>chat"]
    GW --> STT["Whisper<br/>/audio/transcriptions<br/>voice input · issue #1"]
    GW -. future .-> TTSV["TTS<br/>/audio/speech<br/>voice output"]
  end

  SKALD -. "voice input — decoupled<br/>from the chat provider" .-> STT
```

## Providers (multi-API)

Skald has one internal wire format (Anthropic-shaped: content blocks, tool_use /
tool_result, SSE) and routes each turn to one of three providers:

- **anthropic** — direct to `api.anthropic.com` (the default; native server
  tools, prompt caching, citations).
- **openrouter** — OpenRouter's Anthropic-compatible `/v1/messages`, so the
  request body is unchanged.
- **openai-compatible** — translated to OpenAI's `/v1/chat/completions` shape by
  `openai-translate.ts` (request) and `openai-stream.ts` (SSE → Anthropic
  events) ([ADR 0009](adr/0009-openai-compatible-provider.md)). Point it at
  OpenAI, or at **anything** OpenAI-compatible — including your own stack.

All three flow over the same direct HTTPS path: streaming via `fetch`
(`anthropic-dangerous-direct-browser-access`), non-streaming utility calls via
Obsidian's `requestUrl` (which bypasses CORS).

## The self-hosted path (zero external token)

The openai-compatible provider can target a **self-hosted** OpenAI-compatible
gateway — LiteLLM in front of Ollama/vLLM (`llm.dunn.dev`). That turns Skald
into a fully self-hosted assistant:

- **Chat** → Ollama / vLLM.
- **Voice input (STT)** → Whisper at `/audio/transcriptions` (issue #1).
  Anthropic has **no** speech-to-text, so transcription is *always* a separate
  engine — and it is **decoupled from chat**: you can run chat on Anthropic
  while voice transcription goes to self-hosted Whisper.
- **Voice output (TTS)** → `/audio/speech` (future).

One LiteLLM virtual key, no external per-token fee. The plugin code doesn't
change between "OpenAI" and "self-hosted" — only the base URL.

## Trust boundaries

Two places untrusted data enters; both are validated at a single chokepoint:

1. **Vault paths from AI tool calls** → `safePath()` (`tools/context.ts`) — the
   sole guard against traversal/escape into the vault filesystem. Tested in
   `tools/context.test.ts` (mutation-verified).
2. **`data.json`** (operator-editable *and* Obsidian-Sync-delivered) →
   `normalizeSettings()` (`settings-normalize.ts`) coerces an unknown provider,
   clamps an insecure base URL, and drops malformed fields.

## Test strategy

- The **pure core** (transport, providers, parsers, tool logic) is unit-tested
  with a **coverage floor** (`vitest.config.ts` thresholds; ~84% lines,
  ratcheting toward 90%) plus **Stryker mutation testing** on the wire parsers.
- The **Obsidian-DOM `view/` layer** is CDP-smoke-tested
  (`scripts/cdp-walkthrough.mjs`), not unit-tested — vitest runs in a `node`
  env with no DOM — so it is excluded from the coverage floor by design.

## Verify

```
pnpm check          # typecheck + tests + 400-line size cap + plugin-lint + build
pnpm test:coverage  # the core coverage floor
pnpm test:mutation  # Stryker on the parsers (also a nightly CI job)
```
