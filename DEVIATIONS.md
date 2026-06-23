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

| File | Cap | Expires | Next move |
|------|-----|---------|-----------|
| `packages/plugin/src/view.ts` | 425 | 2026-09-22 | Extract `setStatus` + status-row setup into `view/status-row.ts` |
| `packages/plugin/src/view/message-list.ts` | 450 | 2026-09-22 | Extract scroll-guard logic into `view/scroll-guard.ts` |

Past deviations (worker/src/index.ts, tools.ts, chat-session.ts) have
all been refactored into per-responsibility modules.

**2026-06-23 — view.ts:** a11y fix (fix/a11y-theme) added `role="status"` +
`aria-live` on statusEl and a non-color error-icon cue, pushing the file to
409 lines. The correct fix is to extract the status-row setup and `setStatus`
into `view/status-row.ts` (9 lines of logic; the deviation expires 2026-09-22).

**2026-06-23 — view.ts (scroll-guard):** fix/ux-scroll-guard added a
`scrollToBottom()` call in `send()`, nudging `view.ts` from 415 to 421 lines;
cap bumped to 425. Extraction into `view/status-row.ts` remains the correct
next move (same expiry 2026-09-22).

**2026-06-23 — message-list.ts:** fix/ux-scroll-guard added `isNearBottom()`,
`scrollToBottom()`, `pendingForceScroll`, and related JSDoc, growing the file
from 375 to 445 lines. The correct follow-up is to extract the scroll-guard
primitives into `view/scroll-guard.ts` (deviation expires 2026-09-22).

**2026-06-23 — chat-session.ts:** the error-UX fix (fix/ux-session-error)
performed the prescribed extraction: the `executeToolsAndContinue` agentic
loop body moved to `chat-session-tool-loop.ts` (`executeToolLeg`). chat-session.ts
dropped back under the 400 cap even after adding the inline-error + Resend
logic, so its deviation entry is removed (not just bumped).

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