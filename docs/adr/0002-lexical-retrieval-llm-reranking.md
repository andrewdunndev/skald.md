# ADR 0002: Lexical retrieval + LLM reranking over vector search

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Retrieval quality is the core accuracy lever. A chat that cannot find
the right note answers confidently and wrongly. The motivating failure
was a real one: "what is Alasdair's current shoe size" returned a poor
answer because the assistant never located the note holding it.

The original architecture answered retrieval with **vector search**:
embed the vault with Workers AI (`bge-base-en-v1.5`, 768-dim), store
vectors in Cloudflare Vectorize, and expose a `find_related` tool that
embeds the query and returns top-K by cosine similarity. That approach
left with the Worker (see [ADR 0001](0001-direct-mode-over-cloudflare-worker.md)).

So the question is open again, and now under harder constraints. A
retrieval approach for direct-mode Skald must:

- run on-device, including mobile, with no backend and no index service;
- stay provider-agnostic -- not depend on one vendor's embedding model
  or vector store;
- stay fresh against a vault that changes constantly, without a reindex
  step the user has to remember;
- be debuggable when it gets an answer wrong.

## Decision

Retrieval is **lexical-first, then LLM-reranked**. No vector index.

1. **Scope before search.** A vault map (folder tree, and for vaults
   under ~300 notes the full path list) is injected into the system
   prompt, and the model is steered to narrow with graph tools
   (`find_by_tag`, `find_by_link`, `recent_notes`, folder listing) and
   to call `outline` before `read_note`. Most lookups resolve by
   structure, not search.
2. **Candidate generation is lexical.** `search_vault` uses Omnisearch's
   BM25 ranking when the Omnisearch plugin is present, and falls back to
   a case-insensitive substring scan otherwise. Always live against the
   current vault.
3. **An LLM reranks.** When there are more than a few candidates, a
   cheap Haiku-tier model (the utility model, see the model-cascade ADR)
   reorders them by relevance to the query and returns the top-K. It
   soft-fails to the original order on any error.

## Why not vectors, and why an LLM reranker

- **Vectors carry an index, and the index is the problem.** Embeddings
  need compute to build and a store to hold, and they go stale as the
  vault changes, so they need reindexing. On a phone that build is
  heavy; off the phone it is the Worker we just removed plus a vendor
  dependency. Lexical search has no index to maintain and is never
  stale.
- **An LLM judges intent; cosine similarity does not.** Embedding
  similarity is a fixed function over chunk vectors. It is weak exactly
  where vault queries are hard: recency and state ("*current* shoe
  size"), negation, and specificity. An LLM reranker reads the query and
  the candidates together and orders them by what was actually asked.
- **BM25 already gives strong recall here.** In a personal vault the
  user's query vocabulary tends to match the words in their own notes,
  which is the case lexical search is best at. BM25 supplies recall; the
  reranker supplies precision and ordering, cheaply.
- **Cost favors rerank.** A rerank is one small Haiku call, promptcache-
  friendly, paid only when you search. A vector index is continuous cost
  and operational surface whether or not it helps.
- **It is transparent.** Lexical hits plus a model's stated ordering are
  inspectable. A vector misrank is opaque -- you cannot see why the
  wrong chunk scored high.
- **It is provider-agnostic.** No dependence on a specific embedding
  model or vector service. The reranker can be any chat model, including
  a local one via OpenRouter.

## Consequences

- **Recall is bounded by lexical overlap and scoping.** A note that is
  semantically relevant but shares no words with the query, and is not
  reachable by tag/link/folder, can be missed. Mitigations: the vault
  map and folder-first routing, the model's freedom to try several
  queries, and the option to install Omnisearch for stronger ranking.
- **Best results depend on Omnisearch being installed.** Without it the
  fallback is a plain substring scan. This is a soft dependency, not a
  hard one.
- **One extra cheap call per search**, gated to Anthropic + key present,
  soft-failing so search never breaks if the rerank call fails.
- **True semantic recall remains a roadmap item**, to be delivered
  either by on-device embeddings or by the agent-host tier
  ([ADR 0008](0008-agent-host-tier.md)), where maintaining an index is
  appropriate. The reranker approach does not foreclose adding vectors
  later as one more candidate source feeding the same reranker.

## Alternatives considered

- **Cloudflare Vectorize + Workers AI (the original).** Rejected with
  the Worker: backend dependency, vendor lock, reindex burden, not
  provider-agnostic, opaque ranking.
- **On-device embeddings (local model).** Deferred to the roadmap. Too
  heavy on mobile today, and still an index to maintain.
- **Pure BM25 with no rerank.** Rejected. Recall is fine but ordering
  and precision suffer on intent-laden queries, which is exactly where
  the assistant was getting confident wrong answers.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0008: Agent-host tier for the heavy path](0008-agent-host-tier.md)
- `tools/rerank.ts` (`rerankCandidates`), `tools/read.ts` (`runSearchVault`)
- `view/vault-map.ts`, `view/skald-baseline.ts` (folder-first / graph-first routing)
