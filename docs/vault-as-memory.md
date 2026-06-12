# Vault-as-memory

scribian's vault-as-memory feature (phase 6) turns your Obsidian vault
into Claude's working memory across chat sessions. Two pieces:

1. **Long-term memory note** — a single vault note Claude reads at
   the start of every chat and can propose updates to. Diff-card
   approval gates every write, same as any other write tool.
   Available in both direct and worker modes.
2. **Semantic search via `find_related`** — Claude can search your
   vault by *meaning*, not just substring. Backed by Cloudflare
   Vectorize + Workers AI embeddings, kept entirely inside your CF
   account (Workers AI's data-usage policy excludes training).
   **Worker mode only** — `find_related` is not available in direct
   mode and is not advertised to the model when running direct.

## Setting it up

### Settings → Memory

- **Enable memory note** — toggle on (default).
- **Memory note path** — default `Scribian/Memory.md`. The note is
  created on first write; nothing exists at this path initially.
- **Reindex vault** — runs the initial embedding pass.

### First-time reindex

Open the command palette and run **Scribian: Reindex vault (for
semantic search)**, or click the **Reindex** button in settings.

The plugin walks every markdown file in your vault (excluding the
configured chats / logs / saved-notes folders, since those are
scribian-generated content you don't want surfaced as "related
notes"), batches them, and ships them to the Worker's `/index`
endpoint. The Worker embeds each note via Workers AI's
`@cf/baai/bge-base-en-v1.5` (768-dim vectors) and upserts to the
`scribian-vault` Vectorize index.

Progress shows in a Notice. For ~1000 notes, expect ~1 minute and a
few cents. Free tier covers ~6K notes; the Workers Paid plan ($5/mo)
extends to ~10K notes inside the included allotment.

## Using the memory note

Just talk to Claude.

> "Remember that my dog Bailey is allergic to chicken."

Claude will propose a `write_note` or `edit_note` targeting your
memory path. You see the diff card, you approve, the memory is
persisted. Next chat session, Claude already knows.

The memory note is a regular Obsidian note — you can edit it directly
in Obsidian, sync it across devices via Obsidian Sync, and version it
with your vault. There's no separate database.

## Using find_related

Just ask Claude about a topic.

> "What have I been thinking about for the photo project?"

Claude will call `find_related` with a relevant query, get back up to
8 ranked matches with similarity scores and excerpts, and synthesize.
The tool returns vault-relative paths with Obsidian-style `[[wiki
links]]` so you can tap directly to open them.

## When to reindex

The plugin tracks a per-file `{mtime, size}` manifest in plugin
storage. On reindex, it diffs the current vault state against the
manifest and ships **only the delta** to the Worker:

- **Added** files get fresh embeddings.
- **Modified** files (mtime or size changed) get re-embedded.
- **Deleted** files have their vectors removed from the index.
- **Unchanged** files are skipped — no Worker call.

For a steady-state 1000-note vault with ~10% monthly churn, a
reindex moves ~3-4 changed notes plus 0-1 deletes through the
Worker. The first-time reindex is full; everything after is
incremental.

Manual reindex via the **Scribian: Reindex vault** command or the
Reindex button in settings. A future enhancement will trigger
incremental sync on vault save events; today it's manual.

## Privacy posture

Vault embeddings stay inside your Cloudflare account. Workers AI's
[data-usage policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
explicitly excludes Customer Content from training:

> Cloudflare does not use your Customer Content to (1) train any AI
> models made available on Workers AI or (2) improve any Cloudflare
> or third-party services.

**The Worker does not persist plaintext vault content.** Vector
metadata is deliberately content-free — only path, title,
heading path (for sections), mtime, and SHA-256 are stored. Embedding
vectors themselves are one-way: cosine similarity over them does
not reconstruct the source text.

This is a deliberate design decision (phase 6 security review,
2026-05-14). An earlier prototype stored a 200-char excerpt in vector
metadata to power preview rendering — that was scrapped because
"a searchable mini-index of your vault content sitting on the Worker"
is a different security posture than "vault stays on disk; the
Worker holds derivative scoring data only." `find_related` results
render excerpts by re-reading the live vault on the plugin side, so
previews are always current AND no plaintext durably leaves the
vault.

When Claude actually responds to a question — that's a separate
path (chat → Worker → Anthropic), and the memory note content + any
context Claude pulls via `find_related` results does pass through
your selected provider (Anthropic by default, OpenRouter if
you've opted in). See `security-model.md` for the full trust
diagram.

## Cost

At personal scale (~1000 notes, ~30 queries/day, 10% monthly churn),
the marginal cost above the $5/mo Workers Paid base is well under
$0.10/month — embedding is the dominant cost, and it's a one-time
pass per indexed note.

A power-user vault of 10K notes still sits inside the Paid plan's
included 10M-dimension allotment.

## Section chunks

Long notes (>1000 chars) with explicit H1/H2 heading structure get
per-section vectors in addition to the `note-summary` vector. The
note-summary captures the broad topical match; section vectors
capture specific passages.

Queries default to the `note-summary` namespace for broad matches.
The Worker `/search` endpoint accepts a `kind: 'section' | 'both'`
override for passage-level search (the `find_related` tool today
uses `note-summary`; a future tool variant will expose passage
mode).

Section IDs follow `section:<path>:<chunkIndex>`; the chunker (in
`worker/src/memory/chunk.ts`) splits at H1 + H2 boundaries and
windows sections longer than ~1500 chars with a small overlap so
concepts crossing the boundary stay embeddable.

## What's not implemented yet

- **Save-time incremental sync** — manifest diff runs on the
  Reindex command today; a future enhancement triggers it
  automatically on vault save events.
- **Section-vector cleanup on delete** — deleting a note removes
  its `note-summary` vector but section vectors orphan until the
  next manual reindex with full state rebuild. Cheap follow-up:
  track per-path section count in the manifest.
- **Daily digest cron** — auto-summarization of recent vault
  activity. Designed; not yet shipped.
- **Memory-note auto-summarization** — when the memory note grows
  too long to inject economically. Claude can be asked to summarize
  manually for now.
- **Passage-mode find_related** — search the `section` namespace
  for deep passage matches via a tool argument. Worker side is
  done; plugin-side toggle pending.
