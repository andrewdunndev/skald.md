![hero](hero.svg)

# scribian

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![status](https://img.shields.io/badge/status-pre--alpha-orange)]()

Vault-native Claude client for [Obsidian](https://obsidian.md/).
Mobile-first (iPhone, iPad, desktop). Streams via WebSocket through
a Cloudflare Worker you deploy to your own CF account with your own
Anthropic API key. Read and write your vault under user approval;
search the web inline; conversations save back into your vault as
markdown.

> **Status:** pre-alpha. Phases 0–6 shipped. Multi-provider
> (Anthropic + OpenRouter) and vault-as-memory (Cloudflare Vectorize
> + Workers AI embeddings) live as of 2026-05-14. BRAT + community
> plugins listing pending — see `campaigns/factory/notes/scribian-roadmap.md`
> in the [storr](https://gitlab.com/dunn.dev/storr) harness for the
> full plan.

## What it is

Two artifacts in one repo:

1. **`packages/plugin/`** — Obsidian community plugin. Chat pane,
   markdown-rendered messages (mermaid, tables, math, internal links),
   diff-card approval for vault edits, server-side web search,
   per-conversation Anthropic / OpenRouter provider switching,
   semantic-search `find_related` over your vault, and a long-term
   memory note Claude can read and propose updates to.
2. **`packages/worker/`** — Cloudflare Worker. Durable Object with
   Hibernation API. Provider-aware dispatch (Anthropic-direct +
   OpenRouter via the Anthropic-compatible `/api/v1/messages`
   endpoint). MCP server (`/mcp`) bridging external clients
   (Claude Code, Cursor, Claude Desktop) to the plugin's vault tools.
   Vectorize + Workers AI bindings for vault embeddings. Optional AI
   Gateway routing. BYO-deployed (you own it, you pay for it).

Plus `packages/protocol/` — the TypeScript wire types shared between
plugin and Worker.

## Architecture

```
Obsidian plugin (iOS / iPad / desktop)
    │  WebSocket — bearer token via Sec-WebSocket-Protocol subprotocol
    ▼
Cloudflare Worker (Durable Object, Hibernation API)
    │  HTTPS streaming — x-api-key auth
    ▼
api.anthropic.com/v1/messages    (or AI Gateway if configured)
```

- Plugin owns conversation history. Worker is stateless except for
  the WebSocket connection itself.
- Vault tools execute locally inside the plugin against Obsidian's
  Vault API. Write tools require explicit user approval via diff
  card before any file is touched.
- Server-side tools (`web_search`, `web_fetch`) run on Anthropic's
  infrastructure and stream results back into the chat.
- Conversations save as plain markdown in your vault — searchable,
  movable, editable like any other note.

## Quick install

You need:

- A Cloudflare account (Workers free tier is fine to start)
- An Anthropic API key from [console.anthropic.com](https://console.anthropic.com/)
- Obsidian 1.4+ on at least one device

### 1. Deploy the Worker

```sh
git clone https://gitlab.com/dunn.dev/scribian.git
cd scribian
pnpm install

cd packages/worker
pnpm exec wrangler login

# Generate a random bearer token; you'll paste this into the plugin too
TOKEN=$(openssl rand -hex 32)
echo "Save this: $TOKEN"
printf "%s" "$TOKEN" | pnpm exec wrangler secret put SCRIBIAN_TOKEN

pnpm exec wrangler deploy
```

Wrangler prints your Worker URL — something like
`https://scribian.<your-subdomain>.workers.dev`. Save it.

See [`docs/deploying-the-worker.md`](docs/deploying-the-worker.md) for
the full guide, including AI Gateway opt-in and an optional
`ANTHROPIC_API_KEY` fallback secret.

### 2. Install the plugin

Today: manual install. Copy `packages/plugin/dist/{manifest.json,
main.js, styles.css}` into your vault's
`.obsidian/plugins/scribian/` folder, enable the plugin in Obsidian.

See [`docs/installing-the-plugin.md`](docs/installing-the-plugin.md)
for the full path, including the upcoming BRAT route.

### 3. Configure

Open Obsidian → Settings → Scribian:

1. **Worker URL** — `wss://scribian.<your-subdomain>.workers.dev`
2. **Worker token** — the hex string you generated above
3. **Anthropic API key** — your `sk-ant-…`
4. **Test connection** to confirm the Worker is reachable

Open the chat pane via the speech-bubble ribbon icon or the "Open
chat" command. Type a question. Watch markdown stream in.

## What's secure

- **Plugin → Worker:** wss:// TLS, bearer-token auth via subprotocol
- **Worker → Anthropic:** https:// TLS, your API key
- **Plugin data:** lives in your vault's `data.json`, encrypted in
  transit between your devices via Obsidian Sync (E2EE)
- **Worker:** stateless except for the open WS, logs metadata only
  (token counts, latency, no message content), runs in your own
  CF account

## What's not E2EE (and why)

Anthropic generates the responses, so they read the prompts. Any
LLM client that claims end-to-end encryption is lying.
[`docs/security-model.md`](docs/security-model.md) has the honest
framing: encrypted at rest between your devices, audited in transit,
minimized in flight.

## Develop

```sh
pnpm install

# Plugin in watch mode, writes into your dev vault
SCRIBIAN_OUT_DIR="$HOME/your-vault/.obsidian/plugins/scribian" \
  pnpm dev:plugin

# Deploy Worker
cd packages/worker
pnpm exec wrangler deploy
```

The plugin requires Hot Reload to auto-pick up changes — install
[pjeby/hot-reload](https://github.com/pjeby/hot-reload) in your dev
vault and drop a `.hotreload` sentinel into the scribian plugin folder.

## License

[MIT](LICENSE). Use, fork, ship. Attribution appreciated.
