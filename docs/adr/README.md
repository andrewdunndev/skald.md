# Architecture Decision Records

Each ADR captures one architecturally significant decision: the context
that forced it, the decision itself, and the consequences we accept by
making it. They are append-only history. We do not edit a decision after
it lands; we supersede it with a new ADR and update the `Status` line of
the old one to point at the replacement.

Format is [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
short, prose, one decision per file. Filenames are
`NNNN-kebab-title.md`, numbered in order of acceptance.

ADRs record *why*. Operator-facing *how* lives in the rest of `docs/`.
Conformance gaps against `dunn.dev/reference` live in `DEVIATIONS.md`.

## The arc

0001 sets the substrate (direct mode, no backend). 0002-0007 are the
native enhancements that make the direct tier economical and accurate
on-device. 0008 is the future heavy path that picks up where the
on-device tier reaches its ceiling. 0009 opens the direct tier to
self-hosted models over a plain OpenAI-compatible endpoint, switchable
alongside Anthropic.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-direct-mode-over-cloudflare-worker.md) | Direct mode over the Cloudflare Worker | Accepted |
| [0002](0002-lexical-retrieval-llm-reranking.md) | Lexical retrieval + LLM reranking over vector search | Accepted |
| [0003](0003-prompt-caching-mobile.md) | Prompt caching tuned for mobile usage | Accepted |
| [0004](0004-context-budget-windowing-compaction.md) | Context-budget management: windowing + compaction | Accepted |
| [0005](0005-model-cascade.md) | Two-tier model cascade (utility + reasoning) | Accepted |
| [0006](0006-citations-grounding-dedup.md) | Citations as grounding, with token de-duplication | Accepted |
| [0007](0007-vault-as-memory.md) | Vault-as-memory note with incremental upkeep | Accepted |
| [0008](0008-agent-host-tier.md) | Agent-host tier for the heavy path | Proposed (exploring) |
| [0009](0009-openai-compatible-provider.md) | OpenAI-compatible provider for self-hosted models | Proposed |
