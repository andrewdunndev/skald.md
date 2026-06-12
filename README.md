![hero](hero.svg)

# scribian

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![status](https://img.shields.io/badge/status-pre--alpha-orange)]()

**Mobile-first AI companion for Obsidian. Install the plugin, paste your
API key, chat. No server to deploy, nothing to host.**

scribian is a Claude client that lives where you write. It streams
responses from Anthropic (or OpenRouter) directly — no relay,
no shared backend, no account beyond your API key. Reads and writes
your vault under explicit user approval. Searches the web inline.
Conversations save back into your vault as markdown. iOS share-sheet
capture turns anything you share from another app into a
Claude-processed vault note.

> **Status:** pre-release. Feature-complete for v1 — direct mode,
> multi-provider (Anthropic + OpenRouter), vault tools with approval,
> vault-as-memory, share-sheet capture. Awaiting the final on-device
> test pass; BRAT + community plugins listing to follow.

## Quick start

### 1. Install the plugin

Today: manual install. Copy `packages/plugin/dist/{manifest.json,
main.js, styles.css}` into your vault's
`.obsidian/plugins/scribian/` folder, enable the plugin in Obsidian.

See [`docs/installing-the-plugin.md`](docs/installing-the-plugin.md)
for the full path, including the upcoming BRAT route.

### 2. Add your API key

Open Obsidian → Settings → Scribian. The five core settings:

1. **Connection mode** — leave on "Direct" (the default for new
   installs)
2. **Provider** — Anthropic (default) or OpenRouter
3. **API key** — your `sk-ant-…` from
   [console.anthropic.com](https://console.anthropic.com/) (or your
   OpenRouter key)
4. **Default model** — `claude-sonnet-4-6` pre-filled
5. **Memory** — toggle on to keep a long-term memory note across
   sessions

Everything else (vault folders, personas, slash commands, capture
settings) is behind an **Advanced** expander and has safe defaults.

### 3. Chat

Open the chat pane via the speech-bubble ribbon icon or **Scribian:
Open chat** from the command palette. Type a question. Watch markdown
stream in.

## What it is

Two artifacts in one repo:

1. **`packages/plugin/`** — Obsidian community plugin. Chat pane,
   markdown-rendered messages (mermaid, tables, math, internal links),
   diff-card approval for vault edits, server-side web search,
   per-conversation Anthropic / OpenRouter provider switching,
   and a long-term memory note Claude can read and propose updates to.
2. **`packages/worker/`** — Cloudflare Worker (optional). Durable
   Object with Hibernation API. Provider-aware dispatch. Vectorize +
   Workers AI bindings for vault embeddings. Optional AI Gateway
   routing. BYO-deployed (you own it, you pay for it).

Plus `packages/protocol/` — the TypeScript wire types shared between
plugin and Worker.

## Going further: the Worker (optional power tier)

The Cloudflare Worker is not required to use scribian. It adds:

- **Semantic search** (`find_related`) — Claude can search your vault
  by meaning, not just substring, backed by Cloudflare Vectorize +
  Workers AI embeddings. This tool is not advertised to the model in
  direct mode.
- **Capture auto-routing** — when you share content via the iOS
  share-sheet, auto-route can append to an existing matching note
  (≥ 0.85 similarity score) rather than always filing to the inbox.
  In direct mode, captures always go to the inbox.
- **Key off-device** — set your Anthropic key as a Worker secret
  instead of in plugin settings, so it doesn't travel in `data.json`
  via Obsidian Sync.
- **Multi-device token management** — issue per-client tokens with
  independent revocation without touching your API key.

See [`docs/deploying-the-worker.md`](docs/deploying-the-worker.md) for
the deploy guide.

## Architecture

**Direct mode (default):**

```
Obsidian plugin (iOS / iPad / desktop)
    │  HTTPS streaming — anthropic-dangerous-direct-browser-access header
    ▼
api.anthropic.com/v1/messages    (or openrouter.ai/api/v1/messages)
```

**Worker mode (optional):**

```
Obsidian plugin (iOS / iPad / desktop)
    │  WebSocket — bearer token via Sec-WebSocket-Protocol subprotocol
    ▼
Cloudflare Worker (Durable Object, Hibernation API)
    │  HTTPS streaming — x-api-key auth
    ▼
api.anthropic.com/v1/messages    (or AI Gateway if configured)
```

In both modes: plugin owns conversation history; vault tools execute
locally inside the plugin against Obsidian's Vault API; write tools
require explicit user approval via diff card; server-side tools
(`web_search`, `web_fetch`) run on Anthropic's infrastructure.

The mode seam is documented in
[`docs/connection-modes.md`](docs/connection-modes.md).

## Trust model

**Direct mode:** your Anthropic (or OpenRouter) API key lives in the
plugin's `data.json` inside your vault. People who sync their vault via
Obsidian Sync should be aware the key travels in the sync payload —
Obsidian Sync is E2EE with your sync password, but the key is plaintext
within the vault. Any other plugin you install can also read it from
the filesystem.

**Worker mode:** the key lives in Cloudflare Worker secrets. The plugin
holds only a revocable bearer token. Obsidian Sync carries the token
(not the key), so the exposure footprint is smaller.

Mitigation either way: set a [spend limit](https://console.anthropic.com/settings/limits)
on the Anthropic console so a leaked key has bounded financial damage.

Full framing in [`docs/security-model.md`](docs/security-model.md).

## Develop

```sh
pnpm install

# Plugin in watch mode, writes into your dev vault
SCRIBIAN_OUT_DIR="$HOME/your-vault/.obsidian/plugins/scribian" \
  pnpm dev:plugin

# Deploy Worker (if you're working on the worker)
cd packages/worker
pnpm exec wrangler deploy
```

The plugin requires Hot Reload to auto-pick up changes — install
[pjeby/hot-reload](https://github.com/pjeby/hot-reload) in your dev
vault and drop a `.hotreload` sentinel into the scribian plugin folder.

## License

[MIT](LICENSE). Use, fork, ship. Attribution appreciated.
