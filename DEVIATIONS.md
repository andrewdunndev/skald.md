# Deviations from dunn.dev/reference

Each entry: which contract check fails, why it's a deviation for this
project specifically, and when we intend to close the gap. Expirations
are honored — once they pass, this repo reports non-conformant again.

## design-system: skipped (permanent)

**What fails:**
- `design-system/grep:global.css` — no `@import "@dunn.dev/reference/tokens/..."` in any global.css
- `design-system/grep:package.json` — no `"@dunn.dev/reference"` in any package.json

**Why:** scribian is an Obsidian community plugin, not a web project.
It runs inside Obsidian's renderer and uses Obsidian's CSS variables
(`--background-primary`, `--text-normal`, `--interactive-accent`, etc.)
so it respects whatever theme the user has installed. Importing
`@dunn.dev/reference/tokens` would hard-code colors that conflict with
the user's theme. Setting tokens via Style Settings (the Obsidian
community plugin for token customization) is the right path if we ever
want operator overrides, not a build-time CSS import.

**Closure:** never. This deviation is permanent for the plugin
package. If a future scribian web surface (e.g., the marketing site at
scribian.dev — see `campaigns/factory/notes/scribian-website.md` in
the storr repo) ships, *it* will conform to the design-system contract
without exception. The plugin stays Obsidian-native.

## pipeline: catalog upstream gap

**What fails:**
- `pipeline/file-contains:.gitlab-ci.yml` — does not reference any
  `gitlab.com/dunn.dev/pipeline/<component>@X.Y.Z` catalog component

**Why:** scribian's `.gitlab-ci.yml` is hand-rolled (typecheck +
plugin esbuild + worker `wrangler deploy --dry-run`) because the
`dunn.dev/pipeline` catalog has no TypeScript/Node build component
yet. The estate is heavy on Go and Rust primitives; a Node primitive
needs to land upstream before scribian can consume it. The closest
existing component, `cloudflare-worker.yml`, deploys via wrangler —
which scribian intentionally doesn't do from CI (Worker is
BYO-deployed per user, not shipped from scribian's CI). Adopting it
would conflict with that design.

**Closure path:** propose a `typescript-build` (or similar) component
upstream in `dunn.dev/pipeline`: pnpm install with lockfile cache +
recursive typecheck + optional build artifact emission. scribian
becomes the first consumer once the component lands. See
`campaigns/factory/notes/scribian-roadmap.md` Open question #1.

**Closure expires:** 2026-08-14 (~90 days from filing). Estate-level
work; scribian doesn't block on it for shipping.

## file-size: per-file LOC cap with documented exceptions

**What fails:** scribian-local rule (no reference contract yet). The
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
scribian-local for v1. After one full refactor cycle on the cap, we
re-evaluate whether `code-size` belongs as a `dunn.dev/reference`
contract (or as a `dunn.dev/pipeline` catalog component). Cross-
project pattern needs at least two consumers (scribian + yotoshelf)
to qualify per the reference's "principles earn a slot" test.