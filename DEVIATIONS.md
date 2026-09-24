# Deviations from dunn.dev/reference

Each entry: which contract check fails, why it's a deviation for this
project specifically, and when we intend to close the gap. A deviation
stands until it's closed or removed from this file.

## design-system: skipped (permanent)

**What fails:**
- `design-system/grep:global.css` — no `@import "@dunn.dev/reference/tokens/..."` in any global.css
- `design-system/grep:package.json` — no `"@dunn.dev/reference"` in any package.json

**Why:** skald is an Obsidian community plugin, not a web project.
It runs inside Obsidian's renderer and uses Obsidian's CSS variables
(`--background-primary`, `--text-normal`, `--interactive-accent`, etc.)
so it respects whatever theme the user has installed. Importing
`@dunn.dev/reference/tokens` would hard-code colors that conflict with
the user's theme. Setting tokens via Style Settings (the Obsidian
community plugin for token customization) is the right path if we ever
want operator overrides, not a build-time CSS import.

**Closure:** never. This deviation is permanent for the plugin
package. If a future skald web surface (e.g., the marketing site at
skald.dev — see `campaigns/factory/notes/skald-website.md` in
the storr repo) ships, *it* will conform to the design-system contract
without exception. The plugin stays Obsidian-native.

## pipeline: catalog upstream gap

**What fails:**
- `pipeline/file-contains:.gitlab-ci.yml` — does not reference any
  `gitlab.com/dunn.dev/pipeline/<component>@X.Y.Z` catalog component

**Why:** skald's `.gitlab-ci.yml` is hand-rolled (typecheck +
plugin esbuild) because the `dunn.dev/pipeline` catalog has no
TypeScript/Node build component yet. The estate is heavy on Go and
Rust primitives; a Node primitive needs to land upstream before skald
can consume it.

**Closure path:** propose a `typescript-build` (or similar) component
upstream in `dunn.dev/pipeline`: pnpm install with lockfile cache +
recursive typecheck + optional build artifact emission. skald
becomes the first consumer once the component lands. See
`campaigns/factory/notes/skald-roadmap.md` Open question #1.

**Closure expires:** 2026-08-14 (~90 days from filing). Estate-level
work; skald doesn't block on it for shipping.

## architecture: direct-mode only (2026-06-12)

**What changed:** skald's deployment shape moved from Worker-mandatory
to direct-mode only. Prior to this date, the architecture required a
Cloudflare Worker as the relay; direct-to-API was not exposed.

**Current shape:** the plugin calls Anthropic (or OpenRouter) directly
via `fetch` with the `anthropic-dangerous-direct-browser-access: true`
CORS header. No server, no Worker, no relay. One mode. See
`docs/adr/0001-direct-mode-over-cloudflare-worker.md` for the full
rationale.

**What this is NOT a deviation from:** no `dunn.dev/reference`
contract covers deployment topology choices. This entry records the
architectural decision so future readers don't mistake "direct mode"
for a regressed feature. The prior Worker-mandatory shape was the
correct v0 design decision; direct-mode-only is the correct v1
decision for community-plugin distribution (no infra barrier to entry).

**Closure:** permanent record. Not a gap to close.