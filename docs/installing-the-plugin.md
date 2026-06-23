# Installing the plugin

Until skald lands in the Obsidian community plugins directory,
installation is manual. Three paths exist, ordered easiest-first.

## Path 1: BRAT (when releases are published)

Status: **coming soon.** When the first BRAT-friendly release is cut,
add `andrewdunndev/skald.md` (the GitHub mirror) to
[BRAT (Beta Reviewers Auto-update Tester)](https://github.com/TfTHacker/obsidian42-brat)
and accept updates as they ship.

## Path 2: Manual copy

For now, the manual route:

1. Build the plugin once:

   ```sh
   git clone https://gitlab.com/dunn.dev/skald.md.git
   cd skald.md
   pnpm install
   pnpm --filter @skald/plugin build
   ```

   This produces `packages/plugin/dist/{manifest.json, main.js,
   styles.css, versions.json}`.

2. Copy those four files into your vault at:

   ```
   <vault>/.obsidian/plugins/skald/
   ```

3. In Obsidian: Settings -> Community plugins -> "Turn on community
   plugins" -> toggle Skald on.

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

After install, open Obsidian -> Settings -> Skald.

1. **Provider** -- Anthropic (default) or OpenRouter.
2. **API key** -- your `sk-ant-...` from
   [console.anthropic.com](https://console.anthropic.com/) (or your
   OpenRouter key if using OpenRouter).
3. **Memory** -- toggle on to enable the long-term memory note.

That's it. Open the chat pane via the speech-bubble ribbon icon or
**Skald: Open chat** from the command palette.

## Vault sync setup (for multi-device use)

If you're installing on a vault shared between people / devices, the
goal is "one config, all devices."

1. **Obsidian Sync settings:**
   - Settings -> Sync -> "Sync community plugins" -> **on**
   - Settings -> Sync -> "Sync plugin data" -> **on**

2. Configure skald once on the primary device. Both the plugin
   code and the configuration (`data.json`) -- including the API
   key -- replicate to other devices.

3. New device:
   - Open the synced vault on the device
   - Wait for Obsidian Sync to pull
   - Enable skald once in Settings -> Community plugins (Sync
     doesn't auto-enable plugins)
   - Open the chat pane -- config is already there

Obsidian Sync is end-to-end encrypted between your devices (with the
sync password). Plugin data -- including the API key -- never leaves
that E2EE channel in plaintext. See `docs/security-model.md` for the
honest framing of what this means in practice.

## Update

If installed via manual copy, repeat path 2 with the latest build.
If installed via BRAT (when available), BRAT does the work.

## Uninstall

Settings -> Community plugins -> Skald -> toggle off -> trash icon to
remove the plugin folder.

## Mobile-specific notes

- **iPhone / iPad:** the ribbon icon lives in the left sidebar (swipe
  from the left edge). The command palette is the small `...` button
  at the bottom-right.
- **Reconnect:** if you background Obsidian, the connection
  drops; on foreground, skald auto-reconnects within a second.
- **Settings tab on phone:** Settings -> swipe -> Skald. The
  layout is the same as desktop (provider + API key +
  memory toggle, with Advanced below).
