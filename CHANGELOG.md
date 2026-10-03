# Changelog

All notable changes to Skald are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Per the Obsidian convention, release tags are bare semver (no `v` prefix) and the
tag always equals `manifest.json`'s `version`.

## [Unreleased]

Work toward the first public release (`0.1.0`).

### Added
- **OpenAI-compatible provider** — connect any OpenAI `/v1`-shaped endpoint
  (self-hosted vLLM/Ollama/LM-Studio or OpenAI itself) and switch between it and
  Anthropic/OpenRouter. Validated end-to-end against a self-hosted
  LiteLLM → Ollama stack. ([ADR 0009](docs/adr/0009-openai-compatible-provider.md))
- **Tool-result compaction** — tool output is densified (TOON for tabular data,
  minify, dedup) before it enters the context, lossless-or-safe.
  ([ADR 0010](docs/adr/0010-tool-result-compaction.md))
- Security policy (`SECURITY.md`) and Code of Conduct.

### Changed
- **Direct-only architecture** — the Cloudflare Worker is removed; the plugin
  streams straight to the provider with your key.
  ([ADR 0001](docs/adr/0001-direct-mode-over-cloudflare-worker.md))
- Image attachment cap raised to 4 MB (sized to provider limits, not the removed
  transport).

### Fixed
- **Critical:** OpenAI-compatible streaming returned nothing — the SSE parser
  dropped eventless `data:` frames (the OpenAI shape). Streaming, tool-call
  ordering, tool ids, and `max_completion_tokens` now correct on that path.
- Mid-stream SSE `error` events are surfaced instead of silently ending a turn.
- Data-safety: tightened the compaction "lossless" guarantees (big integers,
  TOON round-trip verification, surrogate-safe truncation).
- Capture now runs on the cheap utility model rather than the reasoning model.
- Accessibility: connection status is announced; diff colors are theme-safe.

### Removed
- Dead Cloudflare-Worker-era protocol (`echo`/`ping`/`pong`) and other accumulated
  dead code, en route to a clean public repo.

### Security
- `web_fetch` is gated against prompt-injection exfiltration: web tools are
  off by default, and an optional domain allow-list is enforced server-side by
  Anthropic, and on OpenRouter by pinning OpenRouter's own fetch engine
  ([security model](docs/security-model.md)); note-body
  context is delimiter-escaped; the OpenAI base URL is restricted to HTTPS
  (loopback excepted); logs redact key-shaped values.
