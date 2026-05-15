# Installing the plugin

Until scribian lands in the Obsidian community plugins directory,
installation is manual. Three paths exist, ordered easiest-first.

## Path 1: BRAT (when releases are published)

Status: **coming soon.** When the first BRAT-friendly release is cut,
add `scribian/scribian` (the GitHub mirror) to
[BRAT (Beta Reviewers Auto-update Tester)](https://github.com/TfTHacker/obsidian42-brat)
and accept updates as they ship.

## Path 2: Manual copy

For now, the manual route:

1. Build the plugin once:

   ```sh
   git clone https://gitlab.com/dunn.dev/scribian.git
   cd scribian
   pnpm install
   pnpm --filter @scribian/plugin build
   ```

   This produces `packages/plugin/dist/{manifest.json, main.js,
   styles.css, versions.json}`.

2. Copy those four files into your vault at:

   ```
   <vault>/.obsidian/plugins/scribian/
   ```

3. In Obsidian: Settings → Community plugins → "Turn on community
   plugins" → toggle Scribian on.

If you have Obsidian Sync with "Sync community plugins" enabled, the
plugin files propagate automatically to your iPhone / iPad. You only
need to install on one device.

## Path 3: Develop in your vault (contributors)

If you're working on scribian itself, point the build at a vault
directly:

```sh
SCRIBIAN_OUT_DIR="$HOME/path/to/your/vault/.obsidian/plugins/scribian" \
  pnpm dev:plugin
```

esbuild watches for changes and writes new `main.js` to that
directory. Install [pjeby's Hot Reload plugin](https://github.com/pjeby/hot-reload)
in the same vault and drop a `.hotreload` sentinel file into
`.obsidian/plugins/scribian/` so Hot Reload picks up changes
automatically. No more disable/enable cycles.

## Configure

After install:

1. Obsidian → Settings → Scribian
2. **Worker URL:** the `wss://` URL from your Worker deploy
   (see [`deploying-the-worker.md`](deploying-the-worker.md))
3. **Worker token:** the hex token you generated as a Worker secret
4. **Anthropic API key:** your `sk-ant-…` from
   [console.anthropic.com](https://console.anthropic.com/)
5. Tap **Test connection** under the Worker URL field; you should see
   a green Notice: `Worker OK (v3)`

Open the chat pane via the speech-bubble ribbon icon or run
**Scribian: Open chat** from the command palette.

## Quick onboarding via setup URI

The plugin registers a protocol handler at
`obsidian://scribian-setup?endpoint=<worker-url>&token=<worker-token>`.
Tap a link in that shape on a configured Obsidian device and the
plugin writes both fields into settings without keyboard entry.

The intended flow:

1. On your desktop, after `wrangler deploy` finishes and you've
   minted a token, build the URI:

   ```
   obsidian://scribian-setup?endpoint=wss://scribian.you.workers.dev&token=<hex>
   ```

   URL-encode the token if it contains anything beyond hex (the
   recommended `openssl rand -hex 32` token doesn't, but custom
   tokens may).

2. Send the URI to yourself (Apple Notes, Messages-to-self,
   AirDrop). Open it on the target device.

3. Obsidian foregrounds, scribian's protocol handler accepts the
   URI, and you'll see:

   ```
   scribian: configured against wss://… . Open the chat pane to verify.
   ```

The token is bearer-grade. Sharing this URI is sharing the token —
treat it the same as the raw secret. The plugin rejects URIs whose
`endpoint` isn't `http`/`https` so `file://` and `javascript:`
payloads can't reach settings.

## Vault sync setup (for the wife-test)

If you're installing on a vault shared between people / devices, the
goal is "one config, all devices."

1. **Obsidian Sync settings:**
   - Settings → Sync → "Sync community plugins" → **on**
   - Settings → Sync → "Sync plugin data" → **on**

2. Configure scribian once on the primary device. Both the plugin
   code and the configuration (`data.json`) replicate to other
   devices.

3. New device:
   - Open the synced vault on the device
   - Wait for Obsidian Sync to pull
   - Enable scribian once in Settings → Community plugins (Sync
     doesn't auto-enable plugins)
   - Open the chat pane — config is already there

Obsidian Sync is end-to-end encrypted between your devices (with the
sync password). The Worker token and Anthropic key in `data.json`
never leave that E2EE channel.

## Update

If installed via manual copy, repeat path 2 with the latest build.
If installed via BRAT (when available), BRAT does the work.

The wire protocol between plugin and Worker is shared. If a release
note flags a protocol change, redeploy the Worker first
(`pnpm exec wrangler deploy`), then update the plugin.

## Uninstall

Settings → Community plugins → Scribian → toggle off → trash icon to
remove the plugin folder. The Worker stays deployed in your CF
account until you remove it from the Workers dashboard.

## Mobile-specific notes

- **iPhone / iPad:** the ribbon icon lives in the left sidebar (swipe
  from the left edge). The command palette is the small `…` button
  at the bottom-right.
- **WebSocket reconnect:** if you background Obsidian, the connection
  drops; on foreground, scribian auto-reconnects within a second.
- **Settings tab on phone:** Settings → swipe → Scribian. The
  three-section layout (Worker / Anthropic / Vault integration) is
  the same as desktop.
