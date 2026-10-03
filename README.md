![hero](hero.svg)

# skald

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![status](https://img.shields.io/badge/status-pre--release-yellow)](CHANGELOG.md)

**Mobile-first AI companion for Obsidian. Install the plugin, add your
API key, chat. No server to deploy, nothing to host.**

skald is a Claude client that lives where you write. It streams
responses from Anthropic, OpenRouter, or any OpenAI-compatible
endpoint directly -- no relay, no shared backend, no account beyond
your provider key. Reads and writes
your vault under explicit user approval. Searches the web inline.
Conversations save back into your vault as markdown. Optional
[share-sheet capture](docs/share-sheet-capture.md) turns text you
share on iOS into a vault note.

> **Status:** pre-release. Feature-complete for v1 -- direct mode,
> multi-provider (Anthropic, OpenRouter, OpenAI-compatible), vault tools with approval,
> vault-as-memory, share-sheet capture. Awaiting the final on-device
> test pass. Not yet listed in the Obsidian community plugins directory.

> **Project home:** Skald is developed on **GitLab**
> ([dunn.dev/skald.md](https://gitlab.com/dunn.dev/skald.md)) -- CI, code review,
> and the [roadmap](https://gitlab.com/dunn.dev/skald.md/-/boards) live there.
> If you are reading this on GitHub, that is a mirror for discoverability:
> issues and pull requests are welcome and get triaged onto GitLab. See
> [CONTRIBUTING.md](CONTRIBUTING.md).

Architecture decisions are recorded in [`docs/adr/`](docs/adr/).

## Quick start

### 1. Install the plugin

**BRAT (recommended while pre-release).** Install
[BRAT](https://github.com/TfTHacker/obsidian42-brat), run **BRAT: Add a
beta plugin for testing**, and enter `andrewdunndev/skald.md`. BRAT
installs the latest release and keeps it updated.

**Manual.** Copy `main.js`, `manifest.json`, `styles.css`, and `versions.json`
from the latest release (or build them: `pnpm install && pnpm
--filter @skald/plugin build`, output in `packages/plugin/dist/`) into
`<vault>/.obsidian/plugins/skald/`, then enable **Skald** under
Settings -> Community plugins.

Details in [`docs/installing-the-plugin.md`](docs/installing-the-plugin.md).

### 2. Add your API key

Open Obsidian -> Settings -> Skald. The four core settings:

1. **Provider** -- Anthropic (default), OpenRouter, or OpenAI-compatible
2. **API key** -- pick or create the secret holding your `sk-ant-...`
   from [console.anthropic.com](https://console.anthropic.com/) (or
   your OpenRouter / OpenAI-compatible key, plus the base URL); it
   stays in Obsidian's secret storage on this device
3. **Default model** -- `claude-sonnet-5-5` pre-filled
4. **Memory** -- toggle on to keep a long-term memory note across
   sessions

Everything else (vault folders, personas, slash commands, capture
settings) is behind an **Advanced** expander and has safe defaults.

### 3. Chat

Open the chat pane via the speech-bubble ribbon icon or **Skald:
Open chat** from the command palette. Type a question. Watch markdown
stream in.

## What it is

Two packages in one repo:

1. **`packages/plugin/`** -- the Obsidian community plugin. Chat pane,
   markdown-rendered messages (mermaid, tables, math, internal links),
   diff-card approval for vault edits, server-side web search,
   per-conversation Anthropic / OpenRouter / OpenAI-compatible provider switching,
   a long-term memory note Claude can read and propose updates to,
   and token-economy controls (prompt caching, history + tool-result
   compaction) so a direct-to-API chat stays cheap.
2. **`packages/protocol/`** -- the TypeScript wire types shared across
   the project.

How Skald keeps your token spend down -- caching, windowing, and
tool-result compaction -- is documented in
[`docs/context-and-cost.md`](docs/context-and-cost.md).

## Optional companions

- Install **[Omnisearch](https://github.com/scambier/obsidian-omnisearch)** for ranked vault search -- skald uses its BM25 results automatically when it's present, falling back to a substring scan otherwise. Omnisearch is load-bearing for vault search quality; install it.

## Architecture

```
Obsidian plugin (iOS / iPad / desktop)
    |  HTTPS streaming -- anthropic-dangerous-direct-browser-access header
    v
api.anthropic.com/v1/messages    (or openrouter.ai, or your OpenAI-compatible /v1 endpoint)
```

Plugin owns conversation history. Vault tools execute locally inside
the plugin against Obsidian's Vault API. Write tools require explicit
user approval via diff card. Server-side tools (`web_search`,
`web_fetch`) run on the provider's infrastructure and are off by
default ([security model](docs/security-model.md)). One mode, no seams.

> **On the horizon:** the future heavy path is a self-hosted headless
> agent-host (`claude -p` / Claude Agent SDK) the phone connects to.
> Exploring, no dates. See [`docs/adr/0008-agent-host-tier.md`](docs/adr/0008-agent-host-tier.md).

## Network use and privacy

- **Account required.** Skald needs an API key or account with at least
  one provider; there is no Skald service or account.
- **Remote services contacted**, only to run your chats and only with
  the provider you select:
  - Anthropic (`api.anthropic.com`) -- chat, tool use, and the
    provider-side `web_search` / `web_fetch` server tools, which run on
    Anthropic's infrastructure.
  - OpenRouter (`openrouter.ai`) -- chat and web search when selected;
    the public model catalog (`/api/v1/models`, no key sent) populates
    the model picker.
  - A user-configured OpenAI-compatible endpoint -- chat only, at the
    base URL you enter (HTTPS, or loopback for local servers).
- **What is sent:** your messages, the notes you attach or that Claude
  reads through vault tools, and the memory note when enabled. Nothing
  is sent until you send a turn, or share text with capture turned on.
- **No telemetry.** No analytics, tracking, or crash reporting; Skald
  contacts no server of its own.
- **Files outside the vault** are never accessed. Claude's changes to
  your notes wait for your approval; Skald itself saves conversations,
  logs and captures.

## Trust model

Your Anthropic, OpenRouter, and OpenAI-compatible API keys live only
in Obsidian's secret storage, which Obsidian keeps in local storage on
each device, keyed to the vault. The plugin's `data.json` holds the
name of the secret you picked for each provider, never the key, so
Obsidian Sync never carries a key: enter your key on each device.
Secret storage is shared by design, so another plugin you install can
ask for the key by name.

Mitigation: set a [spend limit](https://console.anthropic.com/settings/limits)
on the Anthropic console so a leaked key has bounded financial damage.

Full framing in [`docs/security-model.md`](docs/security-model.md).

## Develop

```sh
pnpm install

# Plugin in watch mode, writes into your dev vault
SKALD_OUT_DIR="$HOME/your-vault/.obsidian/plugins/skald" \
  pnpm dev:plugin
```

The plugin requires Hot Reload to auto-pick up changes -- install
[pjeby/hot-reload](https://github.com/pjeby/hot-reload) in your dev
vault and drop a `.hotreload` sentinel into the skald plugin folder.

## License

[MIT](LICENSE). Use, fork, ship. Attribution appreciated.
