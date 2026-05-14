# Security model

Honest framing first: **scribian is not end-to-end encrypted.**
Anthropic reads your prompts to generate responses; any LLM client
claiming E2EE is lying. What we *can* offer is a transparent
zero-knowledge-relay deployment shape: encrypted in transit, encrypted
at rest between your devices, no central operator.

## What's encrypted

| Hop / state | Encryption | Notes |
|---|---|---|
| Plugin → Worker | TLS (`wss://`) | Bearer token in Sec-WebSocket-Protocol subprotocol, constant-time compared |
| Worker → Anthropic | TLS (`https://`) | Standard Anthropic API auth (`x-api-key`) |
| Plugin data (`data.json`) | E2EE between your devices via Obsidian Sync | OS-level disk encryption on each device (FileVault, iOS) |
| Worker code | n/a | Stateless; no message bodies retained |
| Worker secrets | Encrypted at rest in CF | Standard CF Workers secrets storage |
| Conversations folder | Encrypted at rest if your vault is | Same as any vault note |

## Who can see what

- **You:** everything.
- **Anthropic:** the message content and tool calls in flight. Per
  their TOS, API data is not used for model training by default
  but is processed by their service.
- **Cloudflare:** runs the Worker. Could in theory observe the
  Worker's memory; trust model is "same as any cloud platform you
  deploy code to." If you enable AI Gateway, CF also logs request
  metadata (model, tokens, latency — not message content).
- **Obsidian Sync infrastructure:** sees ciphertext of your vault
  (including plugin data). E2EE with your sync password.
- **Anyone with access to your devices:** can read `data.json`
  (which contains the Worker token and Anthropic key) like any
  other unencrypted file on the device. OS-level disk encryption
  (FileVault, iOS file encryption) protects against offline-device
  attacks.

## Threats and mitigations

### Anthropic key exfiltration via a malicious plugin

The Anthropic key lives in scribian's plugin data, which is
filesystem-readable to any other plugin you install. Obsidian
plugins are not sandboxed from each other.

**Mitigation:** Treat the Anthropic key as you would any other
secret on your device — only install plugins you trust. Use the
Anthropic Console to set [spend limits](https://console.anthropic.com/settings/limits)
so a stolen key has bounded financial damage.

**Alternative:** Set the Anthropic key as a Worker secret
(`ANTHROPIC_API_KEY`) instead of in plugin settings. The Worker
falls back to the secret when plugin settings are blank. Trade-off:
new devices joining via Obsidian Sync don't auto-configure — they
need the Worker URL + token (still in plugin data), but no longer
the Anthropic key.

### Worker token leak

The Worker token is a static bearer with no expiry or rotation.
If it leaks (lost device, accidental paste, compromised plugin
in the same vault), anyone with the URL + token can run chat
sessions on your CF account, billing your Anthropic key.

**Mitigation:** Rotate immediately on suspected leak:

```sh
TOKEN=$(openssl rand -hex 32)
printf "%s" "$TOKEN" | pnpm exec wrangler secret put SCRIBIAN_TOKEN
# Update plugin settings on each device
```

The new token invalidates the old one on the Worker side.

### Compromised device

If someone gets physical access to an unlocked device, they have
your vault contents plus the keys to your LLM. Same threat model
as any unencrypted local file.

**Mitigation:** Device-level passcodes / biometrics / FileVault.

### Worker runtime compromise

Theoretically Cloudflare could read Worker memory. Practically the
same trust model as any cloud deployment. If this matters to you,
self-host on hardware you control.

## What we deliberately do NOT do

- **Add an encryption layer over the WebSocket.** It would be
  encryption theater on top of TLS and break debugging. The
  honest answer is "TLS protects the wire."
- **Log message content** in the Worker. The Worker logs token
  counts, latency, and stop reasons — no prompts or responses.
- **Run a shared backend.** Every user deploys their own Worker.
  No central operator to compromise.
- **Persist conversations on the Worker.** They're stored in your
  vault and exist on disk wherever your vault syncs to.

## What you control

- The CF account hosting the Worker
- The Anthropic API key
- The Worker source code (deployable from this repo)
- The vault where conversations and plugin data live
- The Obsidian Sync (or other sync) configuration

## Honest README framing

If you write about scribian publicly:

- ✅ "encrypted at rest between your devices, audited in transit,
  minimized in flight"
- ✅ "zero-knowledge relay"
- ✅ "your prompts go to Anthropic; the Worker is just a stateless
  proxy you deploy yourself"
- ❌ "end-to-end encrypted"
- ❌ "private chat that nobody else can read"
- ❌ "your data never leaves your device"

Anyone evaluating LLM clients for privacy will rightly call out
overclaims. Be the honest one.
