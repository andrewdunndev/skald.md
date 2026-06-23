# ADR 0010: Tool-result compaction

- Status: Accepted
- Date: 2026-06-22
- Deciders: Andrew Dunn

## Context

The direct tier spends the user's tokens per query, and the token-control
work so far targets two surfaces: prompt caching
([ADR 0003](0003-prompt-caching-mobile.md)) and conversation *history*
(windowing + size-triggered compaction,
[ADR 0004](0004-context-budget-windowing-compaction.md)). Neither touches
the third big sink in an agentic vault client: **tool-output bloat**. A
`read_note` on a large file, or a `search_vault` that returns many hits, can
dump thousands of tokens of mostly-structural text into the model's context.

Today the only defense is a hard byte cap (`capResult` / `MAX_TOOL_RESULT_BYTES`),
which *truncates* — it drops the tail and appends a "narrow your query" footer.
Truncation is the blunt version of the right idea: we'd rather **shrink the
result structurally** so more of its information survives the budget, and only
truncate what's left.

## Decision

Add **deterministic, on-device tool-result compaction** — a pure function
(`tool-compact.ts`) applied to a tool's result before it enters the model
context. It is lossless-or-safe: on any parse/encode error, or when the
transform wouldn't shrink the result, it returns the input unchanged. Pipeline:

- **Uniform tabular JSON** (a flat array of objects, ≥ 8 rows) → encode as
  **TOON** (`@toon-format/toon`), a compact table-shaped notation that declares
  fields once and streams rows. Prefixed with a one-line marker so the model
  knows the format. ~30–60% fewer tokens than JSON on this shape.
- **Other JSON** → minified (whitespace stripped).
- **Plain text / logs** → collapse runs of identical consecutive lines, strip
  trailing whitespace, collapse excess blank lines.

Gated behind a `compactToolResults` setting (default **on**) so a user on a
weaker model can disable it. The byte cap (`capResult`) **remains the hard
backstop** — compaction reduces how often it fires and how much it has to drop.

No backend, no model call: this is pure TypeScript that runs in the plugin,
distinct from the cheap-model cascade ([ADR 0005](0005-model-cascade.md)).

## Consequences

- **Complements ADR 0004, doesn't overlap it.** 0004 compacts *history*; 0010
  compacts *tool output*. Together they cover history + tool bloat; caching
  (0003) and the cascade (0005) are the other two token levers.
- **Cache-safe.** Compaction only changes the current turn's `tool_result`
  blocks, which sit after the cached prefix; the prompt-prefix ordering was
  audited and the cache breakpoints (system + last tool definition) are
  untouched. No cache busting.
- **TOON readability is a real tradeoff.** TOON reads well for Claude and
  capable models; weaker open models may parse it less reliably. That's why
  it's gated to clearly-tabular data *and* behind the setting — degrade to the
  setting-off path if a backend mishandles it.
- **Ordering, and the named refinement.** Compaction is applied at the single
  tool-dispatch point, which runs *after* each tool's internal `capResult`. For
  the many tools whose results sit under the cap this captures the full benefit
  (no truncation happened; the whole result is densified). For the few
  **large-output tools** — `search_vault`, `list_notes`, `read_note` — the
  result is truncated to the cap *first*, so only the surviving slice is
  densified. The refinement is to compact those three *before* their cap (so
  more rows survive the budget), and to revisit whether the 4 KB
  `MAX_TOOL_RESULT_BYTES` should rise now that results densify. Deferred to keep
  this change off the ~15-runner hot path; tracked as the next step.
- **Bundle.** `@toon-format/toon` is pure TS and ships in the plugin bundle
  (not externalized).

## Future work

- Compact-before-cap for the large-output tools (above).
- Optional **utility-model extractive summarization** of very large *reused*
  context, run on the cheap cascade tier ([ADR 0005](0005-model-cascade.md)) —
  deferred until end-to-end ROI is measured (the compressor call costs tokens
  and latency, so it only pays on big, reused blobs).

## References

- [ADR 0003: Prompt caching tuned for mobile usage](0003-prompt-caching-mobile.md)
- [ADR 0004: Context-budget management: windowing + compaction](0004-context-budget-windowing-compaction.md)
- [ADR 0005: Two-tier model cascade](0005-model-cascade.md)
