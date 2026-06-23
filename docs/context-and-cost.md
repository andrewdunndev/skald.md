# Context & cost

Skald is direct-only: it spends *your* API tokens on every turn, so keeping
the context lean is keeping your bill low. Four mechanisms do that, each
recorded as an architecture decision. This page is the map; the ADRs are the
reasoning.

## The four levers

| Lever | What it does | ADR |
|---|---|---|
| **Prompt caching** | Keeps the stable prompt prefix (system prompt, tool definitions) byte-identical across turns so the provider serves it from cache at ~10% of input price. Tuned with a 1-hour TTL for the bursty, gappy way mobile chat actually happens. | [0003](adr/0003-prompt-caching-mobile.md) |
| **History windowing + compaction** | Bounds the *conversation* — old turns are windowed out and, past a size trigger, summarized so a long chat doesn't grow the prompt without limit. | [0004](adr/0004-context-budget-windowing-compaction.md) |
| **Tool-result compaction** | Shrinks *tool output* — a big note read or a search dump — structurally before it enters the context, so more of its information fits the budget and the hard truncation cap fires less. | [0010](adr/0010-tool-result-compaction.md) |
| **Two-tier model cascade** | Runs cheap, mechanical work (reranking, memory upkeep) on a small utility model and reserves the reasoning model for the actual answer. | [0005](adr/0005-model-cascade.md) |

Caching and the cascade are always on. Windowing/compaction engage as a
conversation grows. Tool-result compaction is on by default and can be turned
off in settings (see below).

## Tool-result compaction

The biggest single token sink in an agentic vault client is a tool result —
`read_note` on a large file, or `search_vault` returning many hits. Skald
shrinks those structurally before they reach the model, losslessly or safely
(if a transform wouldn't help, or anything goes wrong, the original is used
unchanged):

- **Tabular JSON** (a uniform list of records) is re-encoded as
  [TOON](https://github.com/toon-format/toon) — a compact table notation that
  names the columns once and streams rows, typically 30–60% fewer tokens than
  JSON. The result is labeled so the model knows the format.
- **Other JSON** is minified.
- **Text and logs** have repeated lines collapsed and excess whitespace
  stripped.

For the three large-output tools (`read_note`, `list_notes`, `search_vault`),
compaction runs **before** the size cap, so more information survives the budget
(more table rows fit within 4 KB).  All other tool results are compacted at the
dispatch point.  Either way, a hard byte cap backstops anything still too large
after compaction, truncating with a "narrow your query" hint.

**Setting:** *Compact tool results* (Advanced, default on). Turn it off if you
run a model that parses the compact table format unreliably — Skald will send
tool output verbatim instead.

## Self-hosting to skip the per-token bill entirely

The levers above reduce metered API cost. The way to *avoid* it is to point
Skald at a model you host: see the provider settings for connecting an
OpenAI-compatible endpoint ([ADR 0009](adr/0009-openai-compatible-provider.md)),
and the future agent-host tier ([ADR 0008](adr/0008-agent-host-tier.md)) for
running a persistent Claude-quality agent on your own subscription rather than
the metered API.
