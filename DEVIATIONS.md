# Deviations from dunn.dev/reference

Each entry: which contract check fails, why it's a deviation for this
project specifically, and when we intend to close the gap. Expirations
are honored — once they pass, this repo reports non-conformant again.

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
plugin esbuild + worker `wrangler deploy --dry-run`) because the
`dunn.dev/pipeline` catalog has no TypeScript/Node build component
yet. The estate is heavy on Go and Rust primitives; a Node primitive
needs to land upstream before skald can consume it. The closest
existing component, `cloudflare-worker.yml`, deploys via wrangler —
which skald intentionally doesn't do from CI (Worker is
BYO-deployed per user, not shipped from skald's CI). Adopting it
would conflict with that design.

**Closure path:** propose a `typescript-build` (or similar) component
upstream in `dunn.dev/pipeline`: pnpm install with lockfile cache +
recursive typecheck + optional build artifact emission. skald
becomes the first consumer once the component lands. See
`campaigns/factory/notes/skald-roadmap.md` Open question #1.

**Closure expires:** 2026-08-14 (~90 days from filing). Estate-level
work; skald doesn't block on it for shipping.

## architecture: direct-mode pivot (2026-06-12)

**What changed:** skald's headline deployment shape flipped from
Worker-mandatory to direct-mode-default. Prior to this date, the
architecture was: plugin → Cloudflare Worker (required) → Anthropic.
The Worker was the only supported path; direct-to-API was not exposed.

**New shape:** fresh installs default to `connectionMode = 'direct'`.
The plugin calls Anthropic (or OpenRouter) directly via `fetch` with
the `anthropic-dangerous-direct-browser-access: true` CORS header.
No Worker needed. The Worker is now an opt-in power tier that adds
semantic vault search (`find_related` via Vectorize), capture
auto-routing, key-off-device, and per-client token revocation.

**Migration:** existing installs that have a Worker URL already in
`data.json` stay on `connectionMode = 'worker'` via
`migrateConnectionMode()` in `settings/connection-mode.ts`. The
upgrade is non-disruptive. Unknown mode strings stored by a newer
version fall back to `'direct'` at runtime via `resolveConnectionMode()`
without clobbering the stored value.

**What this is NOT a deviation from:** no `dunn.dev/reference`
contract covers deployment topology choices. This entry records the
architectural decision so future readers don't mistake "direct mode"
for a regressed feature. The prior Worker-mandatory shape was the
correct v0 design decision; direct-mode-default is the correct v1
decision for community-plugin distribution (no infra barrier to entry).

**Closure:** permanent record. Not a gap to close.

---

## file-size: per-file LOC cap with documented exceptions

**What fails:** skald-local rule (no reference contract yet). The
`pnpm check:size` script enforces a 400-line cap on every TS file under
`packages/*/src` (test files included). Cap is total lines; the
yotoshelf project's experience converged on 250 for Go / 400 for TS as
the threshold where modules start hiding too much. Rationale: shrink
the surface an LLM (or reviewer) has to scan when reasoning about a
change.

**Current exceptions** (also listed in `scripts/check-size.mjs` for
machine-readability):

_None._ Every TS source file is currently under the 400-line cap.
Past deviations (view.ts, worker/src/index.ts, tools.ts) have all
been refactored into per-responsibility modules.

**Why deviations exist at all:** files that house complete
subsystems whose decomposition is a real refactor, not a renaming
pass, may earn a temporary cap-override with a hard expiration date
and a one-line "next move." An expired deviation fails the check.

**Closure path:** refactor by the date; the check fails as
`EXPIRED-DEVIATION` after expiry, forcing the work. The script also
catches stale deviations — a file that drops under the cap fails as
`STALE-DEVIATION` until removed from the exception list.

**Reference-upstream candidacy:** the rule is intentionally
skald-local for v1. After one full refactor cycle on the cap, we
re-evaluate whether `code-size` belongs as a `dunn.dev/reference`
contract (or as a `dunn.dev/pipeline` catalog component). Cross-
project pattern needs at least two consumers (skald + yotoshelf)
to qualify per the reference's "principles earn a slot" test.