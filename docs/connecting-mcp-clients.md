# Connecting MCP clients

scribian's Worker doubles as an [MCP](https://modelcontextprotocol.io/)
server. Once deployed, you can connect Claude Code, Cursor, Claude
Desktop, Windsurf, or any other MCP-capable client to query the same
vault that scribian's chat pane talks to.

**Constraint:** Obsidian must be running and the scribian chat pane
must be open (= a plugin WS attached to the Worker's DO) for tool
calls to succeed. The Worker forwards MCP tool calls over that WS;
the plugin executes them against the Vault API locally and replies.
If no plugin is attached, MCP tools return a friendly error
pointing the user at the chat pane.

## Tools exposed via MCP

Read-only mirror of scribian's plugin tools:

- **read_note(path)** — full content of a note by path
- **list_notes(folder?, limit?)** — paths of notes, optionally filtered
- **search_vault(query, limit?)** — substring search with snippets
- **current_note()** — path + content of the active note in Obsidian
- **metadata(path)** — frontmatter, tags, headings, backlinks (JSON)

Write tools (write_note, edit_note, append_to_note) are deliberately
not exposed via MCP. Approval flow runs only inside scribian's chat
pane; we don't want external clients quietly mutating the vault.

## Configuration

- **URL:** `https://scribian.<your-subdomain>.workers.dev/mcp`
- **Auth:** `Authorization: Bearer <token>` — a per-client token
  from your `SCRIBIAN_TOKENS` Worker secret with the `mcp:read`
  scope. Don't reuse the plugin token; generate a fresh one per
  MCP client so you can revoke just that client if needed.

Don't confuse the URL prefix with the WebSocket one — `https://` for
MCP (HTTP transport), `wss://` for the plugin's chat WS.

### Generating an MCP client token

See [`deploying-the-worker.md`](deploying-the-worker.md) for the
`SCRIBIAN_TOKENS` JSON format. Quick recap:

```sh
# Generate a new token
CLAUDE_CODE=$(openssl rand -hex 32)
echo "Token for Claude Code: $CLAUDE_CODE"

# Append it to your SCRIBIAN_TOKENS JSON, then push:
pnpm exec wrangler secret put SCRIBIAN_TOKENS
# (paste the updated array)
```

### Claude Code

`~/.config/claude-code/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "scribian",
      "url": "https://scribian.YOUR-SUBDOMAIN.workers.dev/mcp",
      "transport": "streamableHttp",
      "auth": {
        "type": "bearer",
        "token": "YOUR_SCRIBIAN_TOKEN"
      }
    }
  ]
}
```

Replace `YOUR-SUBDOMAIN` and `YOUR_SCRIBIAN_TOKEN`. Restart Claude
Code; `/mcp` should list `scribian` and the five tools.

### Cursor

`~/.cursor/config/mcp.json` (or per-project `.cursor/mcp.json`):

```json
{
  "mcpServers": [
    {
      "name": "scribian",
      "url": "https://scribian.YOUR-SUBDOMAIN.workers.dev/mcp",
      "transport": "streamableHttp",
      "auth": {
        "type": "bearer",
        "token": "YOUR_SCRIBIAN_TOKEN"
      }
    }
  ]
}
```

### Claude Desktop

`~/.config/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "scribian": {
      "url": "https://scribian.YOUR-SUBDOMAIN.workers.dev/mcp",
      "transport": "streamableHttp",
      "auth": {
        "type": "bearer",
        "token": "YOUR_SCRIBIAN_TOKEN"
      }
    }
  }
}
```

## Smoke test

From a terminal:

```sh
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SCRIBIAN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://scribian.YOUR-SUBDOMAIN.workers.dev/mcp
```

You should get JSON-RPC back with the five tools described above.

A subsequent `tools/call` requires Obsidian to be open:

```sh
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SCRIBIAN_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": { "name": "list_notes", "arguments": { "limit": 10 } }
  }' \
  https://scribian.YOUR-SUBDOMAIN.workers.dev/mcp
```

## Use cases

- **Reference your vault from Claude Code:** "What did I write about
  the redesign in the planning docs?" Claude Code uses
  `search_vault` + `read_note` to pull context without you opening
  Obsidian.
- **Cursor referencing personal notes:** while writing code, point
  Cursor at scribian to pull architectural notes, decisions, or
  meeting notes from the vault.
- **Cross-tool agents:** any MCP-capable agent can read your vault.
  The same token guards everything; revoke once on the Worker
  (`wrangler secret put SCRIBIAN_TOKEN`) and all clients lose access.

## Limitations

- **Read-only.** Vault edits go only through scribian's chat pane
  with diff-card approval. This is deliberate.
- **Plugin must be online.** No background daemon; the Vault API is
  only accessible from inside Obsidian.
- **One-vault.** The token maps to one Obsidian vault (whichever the
  plugin is currently configured against). Switching vaults means
  switching what MCP sees.
- **No OAuth.** Static bearer token. If you ever need to rotate,
  rotate `SCRIBIAN_TOKEN` on the Worker AND every MCP client
  config + the plugin setting.

## Troubleshooting

**"No Obsidian plugin is currently connected"** — open Obsidian +
the scribian chat pane.

**HTTP 401** — wrong token or wrong format. Header must be
`Authorization: Bearer <token>` with a space after `Bearer`.

**HTTP 405** — sent a GET. `/mcp` accepts POST only.

**Tool call times out (8s)** — plugin received the call but
crashed or hung. Check Obsidian devtools (Cmd+Opt+I) for errors,
or the configured logs folder.

**Schema mismatch warnings** — MCP_TOOLS in the Worker mirrors
plugin tools. If the plugin's tool schema drifts (rare), regenerate
the Worker side and redeploy.
