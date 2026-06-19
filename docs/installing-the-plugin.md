# Installing the plugin

Until skald lands in the Obsidian community plugins directory,
installation is manual. Three paths exist, ordered easiest-first.

## Path 1: BRAT (when releases are published)

Status: **coming soon.** When the first BRAT-friendly release is cut,
add `skald/skald` (the GitHub mirror) to
[BRAT (Beta Reviewers Auto-update Tester)](https://github.com/TfTHacker/obsidian42-brat)
and accept updates as they ship.

## Path 2: Manual copy

For now, the manual route:

1. Build the plugin once:

   ```sh
   git clone https://gitlab.com/dunn.dev/skald.git
   cd skald
   pnpm install
   pnpm --filter @skald/plugin build
   ```

   This produces `packages/plugin/dist/{manifest.json, main.js,
   styles.css, versions.json}`.

2. Copy those four files into your vault at:

   ```
   <vault>/.obsidian/plugins/skald/
   ```

3. In Obsidian: Settings → Community plugins → "Turn on community
   plugins" → toggle Skald on.

If you have Obsidian Sync with "Sync community plugins" enabled, the
plugin files propagate automatically to your iPhone / iPad. You only
need to install on one device.

## Path 3: Develop in your vault (contributors)

If you're working on skald itself, point the build at a vault
directly:

```sh
SKALD_OUT_DIR="$HOME/path/to/your/vault/.obsidian/plugins/skald" \
  pnpm dev:plugin
```

esbuild watches for changes and writes new `main.js` to that
directory. Install [pjeby's Hot Reload plugin](https://github.com/pjeby/hot-reload)
in the same vault and drop a `.hotreload` sentinel file into
`.obsidian/plugins/skald/` so Hot Reload picks up changes
automatically. No more disable/enable cycles.

## Configure

After install, open Obsidian → Settings → Skald.

**Direct mode (default — no server needed):**

1. **Connection mode** should read "Direct" — leave it.
2. **Provider** — Anthropic (default) or OpenRouter.
3. **API key** — your `sk-ant-…` from
   [console.anthropic.com](https://console.anthropic.com/) (or your
   OpenRouter key if using OpenRouter).
4. **Memory** — toggle on to enable the long-term memory note.

That's it. Open the chat pane via the speech-bubble ribbon icon or
**Skald: Open chat** from the command palette.

**Worker mode (optional — adds semantic search + capture auto-routing):**

1. Set **Connection mode** to "Worker".
2. **Worker URL:** the `wss://` URL from your Worker deploy
   (see [`deploying-the-worker.md`](deploying-the-worker.md))
3. **Worker token:** the hex token you generated as a Worker secret.
4. Tap **Test connection**; expect a green Notice: `Worker OK (v3)`.
5. **Anthropic API key** — either paste it here OR store it as a
   Worker secret (`ANTHROPIC_API_KEY`) and leave this field blank.

## Quick onboarding via setup URI (worker mode)

In direct mode, the API key syncs automatically via plugin data (via
Obsidian Sync) — no setup URI needed.

For worker mode, the plugin registers a protocol handler at
`obsidian://skald-setup?endpoint=<worker-url>&token=<worker-token>`.
Tap a link in that shape on a configured Obsidian device and the
plugin writes both fields into settings without keyboard entry.

The intended flow:

1. On your desktop, after `wrangler deploy` finishes and you've
   minted a token, build the URI:

   ```
   obsidian://skald-setup?endpoint=wss://skald.you.workers.dev&token=<hex>
   ```

   URL-encode the token if it contains anything beyond hex (the
   recommended `openssl rand -hex 32` token doesn't, but custom
   tokens may).

2. Send the URI to yourself (Apple Notes, Messages-to-self,
   AirDrop). Open it on the target device.

3. Obsidian foregrounds, skald's protocol handler parses the
   URI, and a confirmation modal appears showing the endpoint
   and a masked preview of the token (`abcd…wxyz`). If skald
   was already configured, the modal also warns that current
   settings will be overwritten.

4. Review and tap **Apply setup**. You'll see a Notice:

   ```
   skald: configured against wss://… . Don't share that link
   — it contains your Worker token.
   ```

   Tap **Cancel** if you don't recognize the endpoint — this
   confirmation step is what makes the URI safe to use even on
   shared / synced devices.

The token is bearer-grade. Sharing this URI is sharing the token —
treat it the same as the raw secret. The plugin:
- rejects URIs whose `endpoint` isn't `http`/`https`
  (`file://` and `javascript:` payloads can't reach settings)
- never silently rewrites settings — every setup URI goes
  through the confirmation modal even when skald was
  unconfigured

## Vault sync setup (for the wife-test)

If you're installing on a vault shared between people / devices, the
goal is "one config, all devices."

1. **Obsidian Sync settings:**
   - Settings → Sync → "Sync community plugins" → **on**
   - Settings → Sync → "Sync plugin data" → **on**

2. Configure skald once on the primary device. Both the plugin
   code and the configuration (`data.json`) replicate to other
   devices.

3. New device:
   - Open the synced vault on the device
   - Wait for Obsidian Sync to pull
   - Enable skald once in Settings → Community plugins (Sync
     doesn't auto-enable plugins)
   - Open the chat pane — config is already there

Obsidian Sync is end-to-end encrypted between your devices (with the
sync password). Plugin data — including the API key (direct mode) or
the Worker token (worker mode) — never leaves that E2EE channel in
plaintext. See `docs/security-model.md` for the honest framing of what
this means in practice.

## Update

If installed via manual copy, repeat path 2 with the latest build.
If installed via BRAT (when available), BRAT does the work.

The wire protocol between plugin and Worker is shared. If a release
note flags a protocol change, redeploy the Worker first
(`pnpm exec wrangler deploy`), then update the plugin.

## Uninstall

Settings → Community plugins → Skald → toggle off → trash icon to
remove the plugin folder. The Worker stays deployed in your CF
account until you remove it from the Workers dashboard.

## Mobile-specific notes

- **iPhone / iPad:** the ribbon icon lives in the left sidebar (swipe
  from the left edge). The command palette is the small `…` button
  at the bottom-right.
- **WebSocket reconnect:** if you background Obsidian, the connection
  drops; on foreground, skald auto-reconnects within a second.
- **Settings tab on phone:** Settings → swipe → Skald. The
  layout is the same as desktop (connection mode + provider + API key +
  memory toggle, with Advanced below).
