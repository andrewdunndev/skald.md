# Vault-as-memory

scribian's vault-as-memory feature (phase 6) turns your Obsidian vault
into Claude's working memory across chat sessions. Two pieces:

1. **Long-term memory note** — a single vault note Claude reads at
   the start of every chat and can propose updates to. Diff-card
   approval gates every write, same as any other write tool.
2. **Semantic search via `find_related`** — Claude can search your
   vault by *meaning*, not just substring. Backed by Cloudflare
   Vectorize + Workers AI embeddings, kept entirely inside your CF
   account (Workers AI's data-usage policy excludes training).

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

The current MVP is full-reindex on demand — no manifest-diff
incremental sync (yet). Re-run the Reindex command after:

- A major batch of note edits / additions
- Bulk imports (Daily Notes plugin output, etc.)
- Renaming or deleting many notes

A future phase 6 sub-feature will track a checksum manifest in the
plugin and ship deltas to the Worker on save events, so this becomes
automatic.

## Privacy posture

Vault embeddings stay inside your Cloudflare account. Workers AI's
[data-usage policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
explicitly excludes Customer Content from training:

> Cloudflare does not use your Customer Content to (1) train any AI
> models made available on Workers AI or (2) improve any Cloudflare
> or third-party services.

The embedding vectors live in your Vectorize index; the source note
content is not retained server-side beyond a short excerpt stored in
each vector's metadata (≤200 chars, used so `find_related` results
include a preview without re-reading the note).

When Claude actually responds to a question — that's a separate path
(chat → Worker → Anthropic), and the memory note content + any
context Claude pulls via `find_related` results does pass through
your selected provider (Anthropic by default, OpenRouter if you've
opted in). See `security-model.md` for the full trust diagram.

## Cost

At personal scale (~1000 notes, ~30 queries/day, 10% monthly churn),
the marginal cost above the $5/mo Workers Paid base is well under
$0.10/month — embedding is the dominant cost, and it's a one-time
pass per indexed note.

A power-user vault of 10K notes still sits inside the Paid plan's
included 10M-dimension allotment.

## What's not implemented yet

- **Section chunks** — long notes currently embed as a single
  `note-summary` vector. Long-form passages don't get their own
  vectors, so `find_related` returns the whole note's topical match
  rather than the specific passage. Section chunking lands in a
  later phase 6 sub-feature.
- **Daily digest cron** — auto-summarization of recent vault
  activity. Designed; not yet shipped.
- **Manifest-diff incremental sync** — full reindex only for now.
- **Memory-note auto-summarization** — when memory grows too long
  to inject economically. Claude can be asked to summarize manually
  for now.
