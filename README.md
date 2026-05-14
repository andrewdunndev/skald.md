![hero](hero.svg)

# scribian

Vault-native Claude client for Obsidian. Mobile-first (iPhone, iPad,
desktop). Streams via WebSocket through a Cloudflare Worker you deploy
to your own CF account with your own Anthropic API key.

**Status:** pre-alpha. Phase 0 — proving the WebSocket path on iOS.

## What this is

Two artifacts in one repo:

- **`packages/plugin/`** — Obsidian community plugin. Mobile-aware
  ItemView, vault-aware tools, `CLAUDE.md` and `.claude/skills/`
  loaded as system context.
- **`packages/worker/`** — Cloudflare Worker, a stateless relay
  between the plugin and the Anthropic Messages API. BYO-deployed,
  paid CF Workers plan required.

Plus `packages/protocol/` for shared TypeScript wire types.

## Architecture

```
Obsidian Plugin (iOS / iPad / desktop)
    │  WebSocket (wss://) — bearer via Sec-WebSocket-Protocol subprotocol
    ▼
Cloudflare Worker (stateless relay, BYO-deployed)
    │  HTTPS streaming — x-api-key auth
    ▼
api.anthropic.com/v1/messages
```

Plugin owns conversation history. Worker is stateless. Plugin executes
all tool calls locally against the Obsidian Vault API.

## Develop

```bash
pnpm install

# Build + watch the plugin, writing into your dev vault
SCRIBIAN_OUT_DIR="$HOME/aa/aa/.obsidian/plugins/scribian" \
  pnpm dev:plugin

# In another shell: deploy the Worker
cd packages/worker
wrangler secret put SCRIBIAN_TOKEN   # paste a long random string
pnpm deploy
```

Then in Obsidian: Settings → Community plugins → enable Scribian.
Settings → Scribian → paste the Worker URL (`wss://...workers.dev`)
and the same token you set as `SCRIBIAN_TOKEN`.

## License

MIT.
