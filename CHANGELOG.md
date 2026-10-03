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
- README "Network use and privacy" section disclosing contacted services, key
  requirement, no telemetry, and vault-only file access; BRAT and manual install
  instructions.
- Security policy (`SECURITY.md`) and Code of Conduct.

### Changed
- Default model is now `claude-sonnet-5-5` (Anthropic and OpenRouter); Sonnet 4.6
  stays selectable.
- Manifest description and author URL updated for the community directory.
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
- **API keys live only in Obsidian secret storage** — Settings → Skald uses
  Obsidian's secret picker for the Anthropic, OpenRouter and OpenAI-compatible
  keys. `data.json` holds only each secret's name, never a key, so Obsidian
  Sync never carries one; enter your key on each device. Requires Obsidian
  1.11.4 or later.
- Remote images and raw HTML in replies and saved conversations show as links
  or text and never load, closing an exfiltration path that needs no web tools.
- Vault tools write only `.md` notes outside dot folders, so never into
  `.obsidian/`; a write never shows a "create" card over an existing file.
- Share-sheet capture is off by default and text only.
- Diff cards approve by button only; swipe-to-approve is gone.
- Saved conversations escape `## You` / `## Claude` lines, so message text
  cannot forge a turn on resume.
