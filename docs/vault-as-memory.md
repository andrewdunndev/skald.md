# Vault-as-memory

skald's vault-as-memory feature turns your Obsidian vault into
Claude's working memory across chat sessions. Two complementary pieces:

1. **Long-term memory note** -- a single vault note Claude reads at
   the start of every chat and can propose updates to. Diff-card
   approval gates every write, same as any other write tool.
2. **Lexical vault search** -- Claude can search your vault by
   keyword and topic using Omnisearch BM25 (when Omnisearch is
   installed) with an LLM reranker to surface the most relevant
   results. Falls back to substring scan without Omnisearch.

## Setting it up

### Settings -> Memory

- **Enable memory note** -- toggle on (default).
- **Memory note path** -- default `Skald/Memory.md`. The note is
  created on first write; nothing exists at this path initially.

### Install Omnisearch (recommended)

Install [Omnisearch](https://github.com/scambier/obsidian-omnisearch)
from the Obsidian community plugins directory. Once it's indexing your
vault, skald uses its BM25 rankings automatically -- no additional
configuration needed. Without Omnisearch, skald falls back to a
substring scan, which works but returns less relevant results on large
vaults.

## Using the memory note

Just talk to Claude.

> "Remember that my dog Bailey is allergic to chicken."

Claude will propose a `write_note` or `edit_note` targeting your
memory path. You see the diff card, you approve, the memory is
persisted. Next chat session, Claude already knows.

The memory note is a regular Obsidian note -- you can edit it directly
in Obsidian, sync it across devices via Obsidian Sync, and version it
with your vault. There's no separate database.

## Using vault search

Just ask Claude about a topic.

> "What have I been thinking about for the photo project?"

Claude will call `search_vault` with a relevant query, get back ranked
matches with excerpts, and synthesize. The tool returns vault-relative
paths with Obsidian-style `[[wiki links]]` so you can tap directly to
open them.

## Privacy posture

Vault search runs entirely inside the plugin against Obsidian's local
vault. Notes are read from disk, ranked locally (via Omnisearch's
BM25 index), and reranked by a brief LLM call. Only the top candidates
-- not the full vault -- are forwarded to the LLM for reranking.

When Claude actually responds to a question, the memory note content
and any vault excerpts Claude pulls via search do pass through your
selected provider (Anthropic by default, OpenRouter if you've opted
in). See `security-model.md` for the full trust framing.
