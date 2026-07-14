# ADR 0004: Context-budget management -- history windowing and stale-result compaction

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Every message sent to the model carries the full conversation history.
As a session grows, that payload grows with it. Left unchecked, long
sessions hit the model's context limit and start returning errors, and
even well before that limit the token cost per turn climbs continuously.

Two separate pressures must be balanced:

1. **Context limits.** The model will reject a payload that exceeds its
   window. The dispatch payload must be trimmed to fit.
2. **Prompt-cache coherence.** ADR 0003 builds cost efficiency on a
   stable cached prefix. Any mechanism that mutates older content on
   every turn shifts that prefix and defeats the cache, spending more
   per turn rather than less.

The full conversation is always kept in memory for display and
persistence. Only what gets sent to the model -- the dispatch payload
-- is subject to trimming.

## Decision

Two stages are applied in sequence to the dispatch payload before every
API call, composed in `chat-session.ts` as:

```
compactStaleToolResults(windowHistory(this.messages))
```

**Stage 1 -- `windowHistory()`.** Trims the message array to a
150,000-token budget (estimated via a 4-chars-per-token proxy) by
dropping the oldest messages from the front. Three hard invariants
hold regardless of what gets dropped:

1. The newest user turn is always kept, even if it alone exceeds the
   budget.
2. `tool_use` / `tool_result` pairs are dropped or kept atomically.
3. The windowed slice is never allowed to begin with a dangling
   `tool_result` whose matching `tool_use` was dropped. An orphaned
   `tool_result` is an Anthropic HTTP 400.

**Stage 2 -- `compactStaleToolResults()`.** Size-triggered: below a
40,000-token threshold (`COMPACTION_TOKEN_THRESHOLD`) it returns
history verbatim. Above that threshold, `tool_result` blocks from
turns older than the 3 most-recent real-user-turns have their content
replaced with the stub string `[earlier tool output omitted to save
context]`. The `tool_use_id` and block type are preserved so pairing
stays intact; only the content is shed.

Compaction fires before windowing. Detail is shed gracefully (stubs)
before whole turns are cut (hard drop).

## Why these choices

- **Size-triggered compaction, not every-turn compaction.** Stubbing
  on every turn would mutate content that falls inside the cached
  prefix described in ADR 0003, churning the cache on every turn and
  erasing the cost gains that caching is there to provide. Leaving
  older tool results verbatim until the payload is large enough to
  matter keeps the prefix stable in short and medium sessions.
- **40k compaction threshold sits well below the 150k windowing
  budget.** This ordering ensures compaction fires first. The model
  loses verbatim older tool output before it loses whole turns, which
  is a less destructive trade-off.
- **Atomic pair handling.** Dropping a `tool_use` without its
  `tool_result`, or starting a slice with an orphaned `tool_result`,
  causes an API error. Both stages enforce atomicity explicitly;
  compaction additionally preserves `tool_use_id` on stubs so the pair
  reference is never broken.
- **4-char/token proxy.** A precise tokenizer would require a
  dependency and per-call overhead. The budget only needs to be
  approximately right -- the model's actual limit is the hard ceiling,
  and the 150k target leaves headroom. The proxy is fast and requires
  no external package.

## Consequences

- **Older tool outputs become stubs above 40k.** The model sees
  `[earlier tool output omitted to save context]` in place of
  verbatim content for old turns. The full history remains on disk and
  in memory for the user; only the dispatch payload is affected.
- **Tool pairing is always preserved.** No HTTP 400s from orphaned
  blocks.
- **This decision couples to ADR 0003 by design.** The size trigger
  exists specifically to protect the cached prefix. A change to the
  caching strategy should revisit the compaction trigger.
- **The 4-char/token proxy is approximate.** For payloads near the
  budget boundary the actual token count may differ from the estimate.
  The 150k target is conservative enough that this has not caused
  limit errors in practice.

## Alternatives considered

- **Compact every turn.** Rejected. Stubs written on every turn shift
  the cached prefix every turn, negating ADR 0003's caching gains.
  The size trigger exists precisely to avoid this.
- **Window only, no compaction.** Rejected. Without compaction, the
  first response to a large payload is to drop whole turns from the
  front. Compaction allows the model to retain more conversational
  turns (with abbreviated tool content) before any turn is lost
  entirely.
- **Precise tokenizer.** Rejected. Adds a dependency and per-call
  compute for a budget that only needs to be approximately right. The
  existing headroom makes the proxy sufficient.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0003: Prompt caching on mobile](0003-prompt-caching-mobile.md)
- `packages/plugin/src/history-window.ts` (`windowHistory`, `compactStaleToolResults`)
- `packages/plugin/src/chat-session.ts` (composition point)
