# iOS share-sheet capture

scribian's share-sheet capture (phase 8) lets you share content from any
iOS app — Safari, Photos, Messages, third-party apps — into your vault
through Claude. Tap the share button, pick the scribian Shortcut, and
the content lands as a Claude-processed note in your captures folder.

## How it works

iOS plugins inside Obsidian can't register directly as share-sheet
targets — that's a system-level Apple limitation, not an Obsidian one.
The canonical workaround across the Obsidian ecosystem (Advanced URI,
Actions URI, Save-to-Obsidian) is the Apple Shortcuts bridge:

```
iOS Share Sheet
  └─ Shortcuts "Scribian Capture" (you install once)
       └─ obsidian://scribian-capture?... URL
            └─ Obsidian launches → scribian plugin protocol handler
                 └─ POST /capture on your Worker (Claude one-shot)
                      └─ Note written to Scribian/Captures/YYYY-MM-DD-<slug>.md
                           └─ (optional) Obsidian opens the captured note
```

The Shortcut is the share-sheet target the iOS system sees. scribian
provides the protocol handler that turns its URL output into a
finished vault note.

## Setup (one-time)

1. **Install scribian** and complete the normal Worker setup
   (`docs/deploying-the-worker.md`) so you have a working chat already.
2. **Install the scribian capture Shortcut.** Open the iCloud share
   link from the scribian repo's `shortcuts/scribian-capture.shortcut`
   on your iPhone or iPad. Tap "Add Shortcut."
3. **Configure the Shortcut.** It will ask once for:
   - Your vault name (the folder Obsidian shows in the vault picker)
   - The capture kind override (default: auto-detect from share input)
4. **Verify settings.** In Obsidian on iOS, open Settings → Scribian →
   Share-sheet capture and confirm the captures folder is what you want
   (default `Scribian/Captures`).

## Daily use

- In Safari: tap share → swipe to find "Scribian Capture" → tap.
- In Photos: tap share → tap "Scribian Capture" with one or more
  photos selected.
- In any text-bearing app (Messages, Notes, Mail): select text → share
  → "Scribian Capture."

scribian picks an appropriate kind-specific capture prompt (separate
defaults for url / text / image / pdf) and tells Claude to produce a
vault-ready note: a title under 8 words, key points as bullets,
suggested tags. The captured note opens in Obsidian when ready unless
you marked it silent in the Shortcut.

## Customizing the capture prompt

Default prompts are baked into the plugin — one per kind. To override:

1. Create a markdown note anywhere in your vault, e.g.
   `Scribian/Prompts/capture.md`.
2. Write the system-style prompt body (frontmatter is stripped).
3. In Settings → Scribian → Share-sheet capture → Custom capture
   prompt, enter the vault-relative path.

Your prompt replaces the kind-default. The captured content is
appended after a `---` separator so Claude sees instructions first,
content second.

## Privacy posture

The capture flow has the same trust boundary as the chat path:

- The shared content traverses your Worker → Claude (Anthropic or
  OpenRouter, depending on your provider setting) → back to your
  Worker → back to the plugin → vault file.
- The Worker doesn't persist any of this. No durable storage. No
  cache. The vault file is the only record.
- Apple Shortcuts URL-decoded payloads are passed through verbatim;
  scribian doesn't log them outside the standard plugin log file (and
  even there, only the kind + outcome — not content).

The protocol handler is namespaced under `scribian-capture` and is an
explicit allowlist of exactly one action. There is no catch-all
dispatcher — a malformed or attacker-crafted URI like
`obsidian://scribian-delete` 404s at the protocol-handler layer, not
inside the plugin.

## Failure modes + mitigations

| Failure | Mitigation |
|---|---|
| URL length limit (~2000 chars on iOS in practice) | Long content: the Shortcut writes content to a vault staging file and passes the path; the plugin reads from disk |
| Binary/images in URL | The Shortcut saves images to `Scribian/Captures/inbox/` first; the URL carries the vault path |
| Encoding mismatches | Shortcut uses a single URL-Encode step; plugin uses `decodeURIComponent`; an optional `b64=true` flag falls back to base64 for content with awkward characters |
| Wrong vault active | URL includes `vault=<name>`; if the wrong vault is foreground, Obsidian prompts to switch |
| iOS backgrounds Obsidian mid-capture | Capture flow is short (one HTTP call); for slow models you can suspend without losing the request — Anthropic's response is forwarded back to the Worker which holds it until the plugin reconnects |

## What's not implemented yet

- **`.shortcut` template file** — the iCloud share link is the long-
  term distribution path; until that's published, see
  `shortcuts/scribian-capture-recipe.md` for the step-by-step Shortcut
  build instructions.
- **Setup URI** — `obsidian://scribian-setup?endpoint=...&token=...`
  for second-device onboarding without re-entering credentials on a
  phone keyboard. Designed; lands in a phase-8 follow-up.
- **Background queue** — if iOS suspends Obsidian during a capture,
  the request is retried on next foreground. v1 attempts the call
  inline; failure surfaces as a Notice the user can retry.
