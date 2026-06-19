# Deploying the Worker

> **You do not need the Worker to use skald.** Direct mode (the
> default) calls Anthropic or OpenRouter from the plugin with no
> server in the middle. The Worker is the optional power tier — deploy
> it when you want semantic vault search (`find_related`), capture
> auto-routing, key off-device, or per-client token revocation.

The skald Worker is a Cloudflare Workers Durable Object that proxies
streaming chat between the Obsidian plugin and the Anthropic Messages
API, and hosts the Vectorize bindings that back `find_related`. You
deploy it to your own CF account; nobody else's Worker handles your
traffic.

## Prerequisites

- Cloudflare account ([sign up](https://dash.cloudflare.com/sign-up))
- `wrangler` CLI (installed via `pnpm install` in this repo)
- Node 22+ and pnpm 11+ (mise recommended)

## One-time setup

```sh
git clone https://gitlab.com/dunn.dev/skald.git
cd skald
pnpm install

cd packages/worker
pnpm exec wrangler login
```

`wrangler login` opens a browser to authorize the CLI against your
CF account. After this you can deploy from the terminal without
re-authenticating.

## Secrets

The Worker needs at least one secret:

### `SKALD_TOKENS` (recommended)

A JSON array of token records — one per client. Each record has a
human-readable label, the token itself, and a list of scopes:

```json
[
  {
    "label": "plugin",
    "token": "<64-hex>",
    "scopes": ["chat"]
  }
]
```

**Scopes:**

- `chat` — open the chat WebSocket (plugin only)

**Generate tokens + post the secret:**

```sh
# Generate
PLUGIN=$(openssl rand -hex 32)

# Build the JSON
cat <<JSON > /tmp/skald-tokens.json
[
  { "label": "plugin", "token": "$PLUGIN", "scopes": ["chat"] }
]
JSON
cat /tmp/skald-tokens.json  # save these — you'll paste into clients

# Push as a Worker secret
cat /tmp/skald-tokens.json | pnpm exec wrangler secret put SKALD_TOKENS

# Clean up
rm /tmp/skald-tokens.json
```

To revoke a single token (say the `claude-code` one): edit the JSON
to remove that entry, push again. Other clients keep working.

### `SKALD_TOKEN` (legacy, single-token fallback)

If `SKALD_TOKENS` is unset, the Worker accepts a single
`SKALD_TOKEN` secret with implicit full scopes. Kept for backward
compatibility — existing deploys keep working unchanged. For new
deploys, use `SKALD_TOKENS` (above) so per-client revocation
works.

### `ANTHROPIC_API_KEY` (optional fallback)

If you don't want to put your Anthropic key in plugin settings (which
syncs across all your devices via Obsidian Sync), set it as a Worker
secret instead. The Worker uses the plugin-supplied key when present
and falls back to this secret when not.

```sh
printf "%s" "sk-ant-..." | pnpm exec wrangler secret put ANTHROPIC_API_KEY
```

For the wife-test design (vault sync onboards her phone with zero
configuration), put the key in plugin settings. The trade-off is
that any Obsidian plugin she installs could read it. For
personal-use vaults this is acceptable.

### `AI_GATEWAY_URL` (optional)

If set, the Worker routes Anthropic calls through Cloudflare AI
Gateway for caching + per-request observability + the option to
fall over to other providers later. BYO-key mode adds no markup.

```sh
# Find your CF account ID at dash.cloudflare.com → Workers & Pages
# Gateway auto-creates on first request — no dashboard setup needed
ACCOUNT_ID="xxx..."
GATEWAY_ID="skald"
printf "%s" \
  "https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/anthropic/v1/messages" \
  | pnpm exec wrangler secret put AI_GATEWAY_URL
```

Direct routing remains the default while the secret is unset.

## Deploy

```sh
pnpm exec wrangler deploy
```

You'll see something like:

```
Total Upload: 7.56 KiB / gzip: 2.51 KiB
Your Worker has access to the following bindings:
Binding                                     Resource
env.SKALD_SESSION (SkaldSession)      Durable Object

Uploaded skald (1.53 sec)
Deployed skald triggers (0.82 sec)
  https://skald.<your-subdomain>.workers.dev
```

The `https://skald.<your-subdomain>.workers.dev` URL is yours.
Paste it (changing `https://` to `wss://`) into the plugin's
"Worker URL" setting.

## Verify

```sh
curl -sS https://skald.<your-subdomain>.workers.dev/health
```

Should respond with JSON:

```json
{
  "ok": true,
  "anthropic_key_present": true,
  "ai_gateway": false,
  "version": 3
}
```

The plugin's Settings → Skald → "Test connection" button does the
same check from inside Obsidian.

## Updating

Pull the latest skald repo, then redeploy:

```sh
git pull
pnpm install
cd packages/worker
pnpm exec wrangler deploy
```

The plugin and the Worker share `@skald/protocol` — if the wire
protocol changes in a non-backward-compatible way, you'll need to
redeploy the Worker before the new plugin version connects. Watch
the changelog for breaking changes.

## CF Workers plan

Free tier is fine for personal use. The Durable Object + Hibernation
API stays under the free-tier CPU budget even for long sessions
because the JS context releases between messages.

If you find yourself running into:

- "code has hung" errors in `wrangler tail` (rare with hibernation)
- Heavy traffic from many users

… consider the Workers Paid plan ($5/mo) for headroom.

## Cost

- **CF Workers:** $0/mo on free tier; ~$5/mo if you upgrade
- **AI Gateway (BYO-key):** no markup
- **Anthropic API:** pay-per-token. For typical chat use Sonnet 4.6
  costs ~$1-15/mo depending on volume. Web search adds $0.01/search
  capped at the `max_uses` per turn (default 5). Set [spend limits
  on the Anthropic console](https://console.anthropic.com/settings/limits)
  to cap exposure.

## Troubleshooting

**Worker won't deploy** — check `wrangler whoami` shows your account.
Re-run `wrangler login` if needed.

**`/health` returns 4xx/5xx** — `wrangler tail` streams logs from the
deployed Worker. Watch it during a connection attempt; the Worker
logs auth failures and chat request metadata.

**Chat connects but Claude errors immediately** — likely the
`ANTHROPIC_API_KEY` is unset on both Worker and plugin. Set one or
both.

**Long responses get cut off** — possibly the WebSocket dropped. The
plugin auto-reconnects with backoff; check `wrangler tail` for the
underlying error.
