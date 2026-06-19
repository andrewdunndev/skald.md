# Security model

Honest framing first: **skald is not end-to-end encrypted.**
Anthropic reads your prompts to generate responses; any LLM client
claiming E2EE is lying. What we *can* offer is a transparent
deployment shape: encrypted in transit, encrypted at rest between
your devices, no central operator.

## How skald connects

skald calls Anthropic (or OpenRouter) directly from inside Obsidian
using native `fetch` with the `anthropic-dangerous-direct-browser-access: true`
header (required by Anthropic to permit browser-origin streaming).
There is no server, no relay, no Worker. One hop from the plugin to
the API.

## What's encrypted

| Hop / state | Encryption | Notes |
|---|---|---|
| Plugin -> Anthropic/OpenRouter | TLS (`https://`) | `anthropic-dangerous-direct-browser-access` header required for streaming from browser origin |
| Plugin data (`data.json`) | E2EE between your devices via Obsidian Sync | Contains the API key; OS-level disk encryption on each device |
| Conversations folder | Encrypted at rest if your vault is | Same as any vault note |

## Who can see what

- **You:** everything.
- **Anthropic:** the message content and tool calls in flight. Per
  their TOS, API data is not used for model training by default
  but is processed by their service.
- **Obsidian Sync infrastructure:** sees ciphertext of your vault
  (including plugin data). E2EE with your sync password. The API key
  is included in the sync payload -- encrypted at rest by Sync.
- **Anyone with access to your devices:** can read `data.json` like
  any other unencrypted file on the device. This exposes the API key.
  OS-level disk encryption (FileVault, iOS file encryption) protects
  against offline-device attacks.

## Threats and mitigations

### API key exfiltration via a malicious plugin

The Anthropic key lives in skald's plugin data (`data.json`), which
is filesystem-readable to any other plugin you install. Obsidian
plugins are not sandboxed from each other.

**Mitigation:** Treat the Anthropic key as you would any other
secret on your device -- only install plugins you trust. Use the
Anthropic Console to set [spend limits](https://console.anthropic.com/settings/limits)
so a stolen key has bounded financial damage.

### Compromised device

If someone gets physical access to an unlocked device, they have
your vault contents plus the key to your LLM. Same threat model
as any unencrypted local file.

**Mitigation:** Device-level passcodes / biometrics / FileVault.

## What we deliberately do NOT do

- **Run a shared backend.** There is no backend at all. No central
  operator to compromise.
- **Persist conversations server-side.** They're stored in your vault
  and exist on disk wherever your vault syncs to.

## What you control

- The Anthropic (or OpenRouter) API key
- The vault where conversations and plugin data live
- The Obsidian Sync (or other sync) configuration

## OpenRouter as an alternative provider

skald supports OpenRouter as an opt-in fallback provider so users
can route to non-Anthropic models (OpenAI, Gemini, Llama, Qwen,
Mistral, etc.) without skald needing per-provider integration code.
This carries a privacy trade-off worth surfacing explicitly.

**What changes when you select OpenRouter:**

- Your prompts (system prompts, conversation history, attached vault
  content, tool calls) traverse one extra hop: plugin (TLS) ->
  OpenRouter (TLS) -> underlying model provider (TLS).
- OpenRouter sees every byte of every request and response on routes
  that go through them. What they do with it depends on their per-
  model + per-provider data policy; see
  <https://openrouter.ai/privacy>.
- The underlying model provider you pick (OpenAI, Google, etc.) has
  its own data-handling policy on top of OpenRouter's.

**What stays the same:**

- TLS protects every hop. Wire snooping isn't a risk.
- Per-provider key isolation: skald stores your OpenRouter key
  separately from your Anthropic key.
- OpenRouter is opt-in -- you explicitly switch providers in settings.
  No silent failover on Anthropic errors.
- Anthropic-direct stays the default. If you don't touch the provider
  setting, your prompts go to Anthropic only.

**What skald does to keep this honest:**

- The plugin shows an inline privacy notice in settings when you
  select OpenRouter, with a direct link to their privacy policy.
- We do not promise OpenRouter doesn't train on your prompts. We
  surface the trade-off and link to their docs.

**Server tools on OpenRouter.** Anthropic's native web_search /
web_fetch server tools are translated to OpenRouter's equivalents
(`openrouter:web_search` / `openrouter:web_fetch`) so the feature
works uniformly across providers. These run on OpenRouter's
infrastructure (Exa as the default search engine) rather than
Anthropic's -- the data trade-off is the same as above.

## Honest README framing

If you write about skald publicly:

- OK: "encrypted at rest between your devices, audited in transit,
  minimized in flight"
- OK: "your prompts go to Anthropic; nothing else stores or reads them"
- OK: "BYO key -- no skald-side account or backend"
- Not OK: "end-to-end encrypted"
- Not OK: "private chat that nobody else can read"
- Not OK: "your data never leaves your device"

Anyone evaluating LLM clients for privacy will rightly call out
overclaims. Be the honest one.
