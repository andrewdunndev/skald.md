# Changelog

All notable changes to Skald are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Per the Obsidian convention, release tags are bare semver (no `v` prefix) and the
tag always equals `manifest.json`'s `version`.

## [Unreleased]

First public release (`0.1.0`).

### Added
- Mobile-first chat pane that streams from Anthropic, OpenRouter, or any
  OpenAI-compatible endpoint, called directly from your device with your own
  key. Default model `claude-sonnet-5-5`.
- Vault tools (search, read, graph, write) with a diff card you approve or
  reject before any note changes.
- Conversations save to your vault as markdown; "Search conversations" finds
  them again.
- Optional long-term memory note with incremental upkeep (off by default).
- Slash commands and personas.
- Optional iOS share-sheet text capture (off by default).
- Token-economy controls: prompt caching, history windowing, and tool-result
  compaction.
- Optional Omnisearch integration for ranked vault search.

### Security
- API keys live only in Obsidian secret storage; `data.json` holds only each
  secret's name, never a key. Requires Obsidian 1.11.4 or later.
- Web tools are off by default; `web_fetch` can be limited to an allow-list.
- Remote images and raw HTML in replies and saved conversations show as links
  or text and never load.
- Vault tools write only `.md` notes outside dot folders, and approval is by
  button only.
- Share-sheet capture is off by default and text only.
- Saved conversations escape `## You` / `## Claude` lines, so message text
  cannot forge a turn on resume.
- The OpenAI-compatible base URL must be HTTPS (loopback excepted); logs
  redact key-shaped values.
