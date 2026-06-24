# ADR 0011: Progressive context disclosure -- shim prefix + on-demand context

- Status: Proposed (exploring -- no committed timeline; post-launch)
- Date: 2026-06-24
- Deciders: Andrew Dunn

## Context

`loadSystemPrompt` front-loads everything into one prefix sent every
turn: the Skald baseline, a full vault-map (the folder/note tree),
persona, the harness `CLAUDE.md` + `skills/` (capped at 16 KB), and the
memory note. On a real vault that is roughly 10k tokens of system prompt,
before the ~17 tool definitions and the history.

[ADR 0003](0003-prompt-caching-mobile.md) put the vault-map and harness
context in the cached prefix deliberately, so caching amortizes them and
Claude can route from turn 1. That holds for long, context-hungry
sessions. It does not hold for the case we actually see most: a short,
mechanical edit ("add milk to Errands"). That turn carries ~10k of
vault-map + skills it never reads, and pays the first-turn cache WRITE of
the whole prefix (2x base on the 1-hour TTL), then a cache READ of it on
each of the read -> edit -> confirm turns. A single grocery edit cost
$0.138 in testing, which is what kicked this off.

Two adjacent ideas pushed on the same wall:

1. **Orient smart, execute cheap** -- run mechanical execution on a
   cheaper model. But prompt caches are *per-model*, so switching
   mid-conversation re-writes the entire prefix on the second model -- a
   net loss on short tasks. The cheaper per-token rate only pays back
   over long mechanical runs.
2. **A multi-staged prefix** -- a small shim, then progressively more. A
   *segmented system prefix* (breakpoints between shim / map / skills)
   does not help: every segment still ships every turn. Breakpoints
   define cache boundaries, not what the model loads.

The real lever is the one Claude Code itself uses: the system prompt
should carry a tiny core plus *tools to fetch heavy context on demand*,
not the context. Heavy context then enters the message history as tool
results -- paid for only when used, cached thereafter -- instead of
riding in every prefix.

## Decision

Direction (design-only; no committed timeline): move Skald from a
front-loaded prefix to **progressive context disclosure**.

- A minimal always-on **shim** prefix: the Skald baseline + persona.
  Small (~1-2k), stable, cheap to cache on any model.
- Heavy context becomes **on-demand**, fetched by tools into the message
  history:
  - **Vault structure** -- rely on the existing `list_notes` /
    `search_vault` tools for discovery. Optionally keep a one-line
    top-level-folder map in the shim for cheap first-hop routing.
  - **Harness skills** (and a large `CLAUDE.md`) -- a load-on-demand
    fetch tool, disclosed only when relevant.
  - **Memory** -- already isolated in its own system block
    ([ADR 0007](0007-vault-as-memory.md) + the 2026-06 caching change);
    stays as-is, or also moves on-demand later.

A simple edit then pays for the shim and nothing else. A context-heavy
task fetches what it needs, once, and it lives in cached history
thereafter.

This also unlocks the **cheap-executor split**: with a 1-2k shim, the
per-model cache re-write that made mid-loop model switching uneconomical
mostly disappears. Small-core-fetch-the-rest and orient-smart-execute-
cheap are one architectural thread, so they are decided together here.
Execution-time delegation to a cheaper model (a planner -> executor
hand-off over a stripped context) is in scope as a follow-on of this
direction; it builds on the shim.

## Consequences

- **Revises** [ADR 0003](0003-prompt-caching-mobile.md)'s sub-decision to
  carry the vault-map and harness context in the cached prefix. The
  1-hour caching mechanism stays; what rides in the cached prefix shrinks
  to the shim.
- **Extends** [ADR 0005](0005-model-cascade.md). The cascade today is
  chat-model + background utility-model; this opens a third seam, a
  cheaper in-loop executor for mechanical turns, contingent on the shim.
  It is the direct, on-device cousin of the heavy
  [agent-host tier](0008-agent-host-tier.md).
- **Routing quality** becomes dependent on the model choosing to fetch
  context. The vault-map existed precisely so Claude routed well from
  turn 1; pulling it out risks path fumbles, and our Qwen test shows
  cheaper models are worse at exactly this judgment. This is the primary
  risk and it gates the change.
- **Latency** -- tasks that need heavy context pay an extra fetch
  round-trip they used to avoid. Acceptable only if the common case is
  the simple one; the spike confirms it.
- More tool definitions (the fetch tools) live in the shim -- small, and
  themselves cached.

## Spike / validation plan

Design-only until a spike answers two questions; ship nothing before it.
The `+Nkw` / `+Nkc` footer instrumentation (landed 2026-06-24) gives the
cost half directly.

Measure, current prefix vs shim, on the same inputs:

1. **Cost** -- a simple edit and a context-heavy task. Compare total $
   and watch `+Nkw` (cache writes): the shim should turn a repeated large
   write into a single small one.
2. **Routing quality** -- with the full vault-map pulled out, does the
   model still land the right file without fumbling, on (a) a capable
   model and (b) a cheap model? Run the read/edit items from
   `docs/feature-inventory.md`.

Success criteria:

- Simple-edit prefix write shrinks from ~10k to ~1-2k AND
- Routing quality holds on the capable model (no new path fumbles on the
  inventory items).

Fallback ladder if routing degrades:

1. Add the one-line top-level-folder mini-map to the shim (cheap routing
   without the full tree).
2. If still degraded on cheap models, keep the fuller map for the
   cheap-executor path only, or gate progressive disclosure behind a
   setting.

Out of scope here: the execution-time cheap-model delegation protocol
(the stripped-context hand-off and its fumble guardrails) -- a follow-on
spike once the shim lands.
