# ADR 0005: Two-tier model cascade -- a cheap utility model behind the reasoning model

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Not all model calls are equal. The conversation itself requires genuine
reasoning -- following context, resolving intent, generating a useful
reply. Sub-tasks like reranking search candidates and curating memory
notes are mechanical and high-volume: they run on every search and every
memory-upkeep cycle, consume tokens in bulk, and do not benefit from a
stronger model beyond a quality threshold that a Haiku-tier model already
clears.

Running every call on the reasoning model pays premium rates for work
that does not need premium reasoning. On a per-token billing model, the
difference between a strong model and a Haiku-tier model is roughly an
order of magnitude. At search or note-curation volumes, that compounds.

The question is how to structure the two tiers so the cascade stays
provider-agnostic and the cheap tier remains overridable for users on
local models.

## Decision

Two model roles are defined in `packages/plugin/src/provider-capabilities.ts`:

- **`reasoningModel(settings)`** -- the strong model that runs the
  conversation. Resolves to `settings.defaultModel` on Anthropic (default
  `claude-sonnet-4-6`, with Opus 4.8 selectable) or
  `settings.openrouterModel` on OpenRouter.
- **`utilityModel(settings)`** -- a cheap model for bulk, judgment-light
  sub-tasks. Resolves to `settings.utilityModel` if the user has set one
  (this override may point at any model, including a local one); otherwise
  defaults to `claude-haiku-4-5` (Anthropic) or
  `anthropic/claude-haiku-4-5` (OpenRouter).

The utility model does two jobs today:

1. **Search reranking** (`rerankCandidates` in `tools/rerank.ts`) -- see
   ADR 0002.
2. **Memory-note upkeep** (`proposeMemoryUpkeep` in `memory-upkeep.ts`)
   -- see ADR 0007.

Both utility calls run via Obsidian's `requestUrl`, not the streaming
chat transport. The reranker's system prompt is prompt-cached with a 1h
TTL (consistent with ADR 0003). The reranker is gated to Anthropic + key
present and soft-fails to the original candidate order on any error.

## Why these choices

**Spend the strong model only where strong reasoning is needed.** Reranking
a list of note candidates and flagging stale memory entries are
high-volume, mechanical tasks. The quality bar is met by a Haiku-tier
model. Routing them to the reasoning model would pay an order-of-magnitude
premium for no quality gain.

**Soft-fail preserves correctness.** The reranker returning the original
order on failure is equivalent to no reranking -- search still works,
just less precisely ordered. The conversation is never blocked by a
utility call failing.

**The `utilityModel` override keeps the cascade vendor-neutral.** A user
running local models can point the utility role at a small local model.
This is the same provider-agnostic posture as the rest of the project
(ADR 0001) applied to the cheap tier specifically.

**Prompt caching on the reranker system block reduces the per-search
cost further.** The system prompt is fixed across calls; caching it with
a 1h TTL (ADR 0003) means only the candidate list pays full input-token
cost.

**Quality is verified by mutation testing, not model size.** The suite
tests that broken reranking and curation are caught, not that a bigger
model would rank better. This is the same verification discipline applied
elsewhere in the project.

## Consequences

- **Two model configurations to reason about.** A user or operator must
  be aware that `utilityModel` and `reasoningModel` are distinct; a
  misconfigured `utilityModel` degrades rerank and curation quality
  without affecting conversation correctness.
- **The cheap model's quality bounds rerank and curation quality.**
  Mitigated by soft-fail on reranking (falls back to original order) and
  by the approval gate plus guards on memory upkeep (ADR 0007).
- **`utilityModel` is the seam for local-model users.** Pointing it at a
  small local model keeps the cascade functional offline and without API
  cost for these sub-tasks.

## Alternatives considered

- **Use the reasoning model for everything.** Rejected. Pays premium rates
  for mechanical work and is slower, increasing search latency on every
  rerank call.
- **A fixed hardcoded Haiku with no override.** Rejected. Breaks the
  provider-agnostic / local-model posture; a user on OpenRouter with a
  preferred small model cannot redirect the cheap role.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0002: Lexical retrieval + LLM reranking](0002-lexical-retrieval-llm-reranking.md)
- [ADR 0003: Prompt caching on mobile](0003-prompt-caching-mobile.md)
- [ADR 0007: Vault-as-memory](0007-vault-as-memory.md)
- `packages/plugin/src/provider-capabilities.ts` (`reasoningModel`, `utilityModel`)
- `tools/rerank.ts` (`rerankCandidates`)
- `memory-upkeep.ts` (`proposeMemoryUpkeep`)
