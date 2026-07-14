# ADR 0003: Prompt caching tuned for mobile usage

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Skald's prefill is large. Each turn sends a system prompt, a vault map,
a tools array, and accumulated history -- often several thousand tokens
before the user's message appears. Without caching, every turn pays
full input cost to re-send that prefix.

Anthropic provides prompt caching, but its default TTL is 5 minutes.
That default is calibrated for desktop/server workflows where turns
arrive in quick succession. Mobile users routinely pause multiple
minutes between turns -- to read a note, switch apps, or put the phone
down. With the 5-minute TTL, those pauses turn the next turn into a
cache miss: the prefix expired, must be rewritten at ~1.25x the base
rate, and then re-sent uncached. The cache offers no net saving for a
session that progresses at a human mobile pace.

## Decision

Skald applies Anthropic prompt caching with `cache_control: { type:
'ephemeral', ttl: '1h' }` -- the 1-hour TTL. Three of Anthropic's
four allowed breakpoints are used, placed at:

1. the system-prompt text block,
2. the last tool in the tools array,
3. the last content block of the second-to-last message (a "moving"
   history breakpoint that advances as the conversation grows).

The fourth breakpoint is intentionally left free (see ADR 0006).
Caching is Anthropic-only, gated by `providerCapabilities('anthropic')
.promptCaching === true`. OpenRouter receives no cache headers.

## Why these choices

- **1-hour TTL over 5-minute default.** A cache write costs ~2x the
  base input rate; a cache read costs ~0.1x. A miss after expiry costs
  ~1.25x to recreate the write PLUS re-sending the full prefix
  uncached. For Skald's prefix length, the 1h write is cheaper than
  two or three misses during a real mobile session. The 5-minute default
  does not survive ordinary pauses; 1h does.
- **Three breakpoints at stable boundaries.** System prompt and tools
  are session-stable. The moving history breakpoint tracks the growing
  conversation while keeping the stable prefix warm. Together they
  maximise hit rate without wasting breakpoints on content that
  changes every turn.
- **Fourth breakpoint reserved.** Consuming all four would leave no
  room for citation document blocks fetched during a session. ADR 0006
  explains the allocation.
- **Capability gate, not provider check.** The gate is
  `providerCapabilities`, not a string comparison, so adding a future
  provider with caching support does not require touching this code
  path.

## Consequences

- **2x write cost on cache creation** is accepted in exchange for
  warm-prefix reads across mobile pauses. The crossover into net saving
  is a single cache hit on a prefix of Skald's size.
- **3 of 4 breakpoints are consumed.** The remaining slot is reserved;
  callers must not add `cache_control` to other content without
  checking the budget. See ADR 0006.
- **Anthropic-only.** OpenRouter users receive no caching and pay full
  input cost every turn. This is a known asymmetry -- OpenRouter's
  capability flag is `false` and no workaround is applied.
- **The moving-history breakpoint depends on a stable prefix.** If
  compaction chops the system prompt or tools, the cache is cold for
  the next turn. ADR 0004 describes cache-aware compaction, which is
  size-triggered specifically to avoid churning this prefix.

## Alternatives considered

- **5-minute default TTL.** Rejected. Expires during ordinary mobile
  pauses, turning the benefit into repeated write cost with no reads.
- **No caching.** Rejected. Re-sends a large prefix every turn; the
  cumulative input cost across a session is substantially higher.
- **Cache citation/document blocks too.** Rejected. Would consume the
  fourth breakpoint and block ADR 0006's citation allocation. Content
  blocks also vary per-query, so hit rate would be low.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0004: Context-budget windowing + compaction](0004-context-budget-windowing-compaction.md)
- [ADR 0006: Citations as grounding + token dedup](0006-citations-grounding-dedup.md)
- `packages/plugin/src/anthropic-caching.ts`
- `packages/plugin/src/direct-transport.ts` (`buildDispatch`)
- `packages/plugin/src/provider-capabilities.ts`
