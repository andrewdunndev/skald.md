# ADR 0006: Citations as grounding, with token de-duplication

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Answers that drew on vault notes without identifying which note left the
user unable to trust or verify them. This was a real, repeated point of
confusion in use: the assistant could give a confident answer from a note
and the user had no way to trace it back or check whether the note had
changed.

The need, then, is grounding -- every answer that draws on a vault note
should be visibly sourced to that note, with a link the user can follow.
But a naive implementation sends the note body twice in the same turn:
once as the `tool_result` for `read_note`, once as a document block for
grounding. At any reasonable read frequency that roughly doubles input
tokens per turn.

## Decision

Skald uses **Anthropic's Citations API** to attach source links to
answers, combined with **tool_result body collapse** to prevent the
double-send.

On a successful `read_note`, the note body is attached to the same user
turn as a `document` content block (`type: 'document'`,
`source.type: 'text'`, `citations: { enabled: true }`), with the
vault-relative path as its title. Anthropic returns `citations_delta`
streaming events; `handleChunk` accumulates them onto the text block and
renders inline `[N]` markers via `citationLabel`, each linking back to
the source note.

The corresponding `tool_result.content` is collapsed to just the path
string `[<path>]`. The body is therefore present exactly once in the
turn -- in the document block -- rather than in both places.

A `documentRegistry` maps `document_index` to vault path. It is cleared
per continuation leg, not just per user turn, so indices stay aligned
across a multi-tool turn and cannot cite the wrong note.

Document blocks are not given `cache_control`. The no-cache choice is a
direct consequence of the breakpoint budget already allocated in ADR 0003,
which uses 3 of Anthropic's 4 breakpoints. Adding a fourth on documents
would exceed the limit.

The citations feature is gated by `providerCapabilities(provider).citations === true`.
OpenRouter has `citations: false`; answers on that provider are ungrounded
by this mechanism.

## Why these choices

**Grounding is a trust and accuracy feature.** The user can see the source
note for each claim and follow the link to verify it. Model-narrated "see
note X" phrasing is hallucinable and not verifiable; an API-level citation
is.

**The tool_result collapse keeps grounding affordable.** Sending the body
in both the `tool_result` and the document block costs roughly 2x input
tokens per read with no benefit -- the model already has the content once.
Collapsing the `tool_result` to the path string preserves the grounding
benefit without the token penalty.

**The per-leg registry reset is what keeps links correct.** Citation indices
are scoped to a single continuation leg. Resetting across legs rather than
only across user turns means a multi-tool sequence cannot shift indices and
link to the wrong note.

**No cache_control on documents is a budget consequence, not a choice.**
ADR 0003 commits 3 breakpoints to the system prompt and session baseline.
The fourth is unavailable, so documents must remain uncached. This is a
known trade-off, not an oversight.

## Consequences

- Answers on Anthropic are grounded: every note drawn on has an inline
  citation the user can follow.
- Note bodies are never sent twice; the token cost of grounding is limited
  to the document block itself.
- OpenRouter answers are ungrounded by this mechanism. The user sees no
  `[N]` markers on that provider.
- The 4-breakpoint budget is fully allocated between caching (ADR 0003)
  and this decision. Any future feature that wants a cache breakpoint
  must displace one of the existing three.
- Multi-tool turns cite correctly because the registry resets per leg, not
  just per turn.

## Alternatives considered

- **No citations / model-narrated "source: X".** Rejected. The model can
  confabulate source references; there is no link for the user to follow;
  the original confusion this solves would persist.
- **Send body in both tool_result and document block.** Rejected.
  Approximately 2x input tokens per read, with no additional benefit to
  the model or the user.
- **Cache the document blocks.** Rejected. Anthropic enforces a 4-breakpoint
  limit per API call. ADR 0003 already allocates 3 breakpoints; a fourth
  on document blocks would exceed the limit and break caching for the
  system prompt and session baseline.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0002: Lexical retrieval + LLM reranking over vector search](0002-lexical-retrieval-llm-reranking.md)
- [ADR 0003: Prompt caching on mobile](0003-prompt-caching-mobile.md)
- `packages/plugin/src/citations.ts` (`handleChunk`, `citationLabel`, `documentRegistry`)
- `packages/plugin/src/chat-session.ts` (document block attachment, tool_result collapse)
