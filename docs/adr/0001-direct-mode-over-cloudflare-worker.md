# ADR 0001: Direct mode over the Cloudflare Worker

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Skald is a mobile-first AI companion that lives inside an Obsidian
vault. The original architecture shipped two connection modes:

- **direct** -- the plugin streams straight from `api.anthropic.com`
  (or OpenRouter) using the user's own API key, with no backend.
- **worker** -- the plugin tunnels over a WebSocket to a Cloudflare
  Worker (Durable Object + Hibernation API) that the user deploys to
  their own CF account. The Worker added three things the plugin alone
  could not do: semantic search (`find_related`, backed by Cloudflare
  Vectorize + Workers AI embeddings), capture auto-routing (append a
  shared item to a semantically matching note above a 0.85 score), and
  keeping the API key off-device as a Worker secret.

In practice the two-mode design worked against the product:

- **It contradicts the value proposition.** The pitch is "install the
  plugin, add your key, chat -- nothing to host." A second mode whose
  whole purpose is "now go deploy and pay for a Cloudflare Worker"
  undercuts that on the first screen.
- **It confused the UI.** Connection mode, Worker URL, Worker token, a
  reindex button that only works in one mode, and capture settings that
  silently change behavior by mode all surfaced to every user, most of
  whom will never run a Worker.
- **It is the wrong substrate for the heavy path.** The genuinely heavy
  capabilities we want next (off-device key, continuous background
  indexing, longer agentic runs, local models) need a persistent agent
  runtime, not a thin edge relay. That direction is the agent-host tier
  (see [ADR 0008](0008-agent-host-tier.md)), which is a self-hosted
  daemon on the Claude Agent SDK / `claude -p`, not a Cloudflare Worker.
  Keeping the Worker as the "power tier" pointed users at a dead-end
  branch.
- **It is a maintenance and lock-in cost.** A 35-file Worker package, a
  second transport, provider dispatch duplicated across plugin and
  worker, and a mode-capability seam threaded through ~20 plugin files,
  all tying the project to one specific cloud vendor.

The MCP integration was already removed in an earlier pass. This ADR
finishes the simplification.

## Decision

Remove the Cloudflare Worker tier entirely. Skald is **direct-only**:
the plugin calls the provider API directly with the user's key. There is
one mode, so there is no mode selector.

Concretely:

- Delete the `packages/worker` package and its deploy path.
- Delete the WebSocket transport; `DirectTransport` is the only
  transport (it still implements the `SkaldTransport` interface so a
  future transport can be added cleanly).
- Remove the connection-mode seam (`mode-capabilities.ts`,
  `ConnectionMode`, the connection-mode and worker settings + UI). It
  will be reintroduced, designed for purpose, when the agent-host tier
  is real.
- Remove the Worker-only features: `find_related` (semantic search via
  Vectorize), vault reindexing, capture auto-routing, and the
  key-as-Worker-secret option.

## Consequences

### What we lose (and the fallback that already exists)

- **Embeddings-based semantic search** (`find_related`). Vault search
  falls back to what already runs in direct mode: Omnisearch BM25 when
  the Omnisearch plugin is present, a case-insensitive substring scan
  otherwise, and an LLM reranker (Haiku-tier) over the candidates.
  Search still works; it is lexical + reranked rather than vector-based.
  Returning real semantic recall is a roadmap item, to be delivered
  either on-device or via the agent-host tier.
- **Capture auto-routing.** Shared items always land in the captures
  folder (the inbox). This was already the direct-mode behavior.
- **Key-off-device.** The API key lives on the device, in Obsidian's
  secret storage (never in `data.json`), and is entered on each device.
  Mitigation is unchanged from the direct-mode security model: set a
  spend limit on the Anthropic console so a leaked key has bounded cost. See `docs/security-model.md`.

### What we gain

- One honest story: a native Obsidian plugin, bring your own key, no
  server, no account. Onboarding is "paste a key."
- A smaller, vendor-neutral codebase: no Worker package, no second
  transport, no mode branching, no Cloudflare dependency.
- A settings surface that matches reality: provider, key, model, vault
  folders, memory. Nothing the typical user cannot act on.

### Neutral

- The provider-agnostic spine (`provider-capabilities.ts`) is unchanged.
  Anthropic-direct and OpenRouter both remain; OpenRouter stays the
  gateway for non-Anthropic and hosted-elsewhere models.

## Alternatives considered

- **Keep the Worker as an optional power tier, just clarify the docs.**
  Rejected. The confusion is structural, not wording, and it still ties
  the heavy path to the wrong substrate.
- **Hide the Worker in the UI but keep the code.** Rejected as a
  half-measure that leaves the maintenance, the lock-in, and the
  dead-end branch in place.

## References

- [ADR 0008: Agent-host tier for the heavy path](0008-agent-host-tier.md)
- `DEVIATIONS.md` -- "architecture: direct-mode pivot"
- `docs/security-model.md` -- direct-mode trust model and the spend-limit mitigation
