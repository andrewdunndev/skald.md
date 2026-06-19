# Contributing to Skald

## Where development happens

GitLab is canonical: [dunn.dev/skald](https://gitlab.com/dunn.dev/skald). CI, code review, and the roadmap all live there.

GitHub ([andrewdunndev/skald](https://github.com/andrewdunndev/skald)) is a mirror for discoverability. Issues and pull requests are welcome there and get triaged onto GitLab. GitHub Discussions are off -- Issues are the single community funnel.

## The roadmap

Lives as GitLab issues on the [project board](https://gitlab.com/dunn.dev/skald/-/boards), organized in two tiers:

- **Tier 1 -- plugin**: native Obsidian plugin, BYO API key, runs on-device including mobile. This is v1, shipping.
- **Tier 2 -- agent-host**: persistent headless companion (`claude -p` / Claude Agent SDK) the phone connects to. Marked **exploring, no dates**.

Labels in use: `roadmap`, `accepted`, `exploring`.

## Reporting bugs / requesting features

Use the issue templates -- they prompt for the information needed to triage. GitHub issues get ported to GitLab; you don't need a GitLab account to file one.

## Code contributions

Prefer a GitLab MR -- CI runs there and review is faster. GitHub PRs are accepted and ported.

Before opening either, run the check gates locally (see below) so CI passes on the first push.

## Dev setup

**Install dependencies:**

```
pnpm install
```

**Monorepo layout:**

- `packages/plugin` -- the Obsidian plugin
- `packages/protocol` -- shared types

**Check gates (all must be green before merge):**

| Command | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm test` | Unit tests via Vitest |
| `pnpm check:size` | 400-LOC-per-file cap |
| `pnpm check:lint` | Manifest/package version parity |
| `pnpm --filter @skald/plugin build` | Plugin bundle compiles |

**Dev vault workflow:** see the "Develop" section in [README.md](README.md).
