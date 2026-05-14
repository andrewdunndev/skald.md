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

## repository: brand artifacts pending iconography pass

**What fails:**
- `repository/file-exists:avatar.svg` — missing
- `repository/file-exists:hero.svg` — missing
- `repository/file-exists:favicon.svg` — missing
- `repository/file-exists:brand.png` — missing

**Why:** brand artifacts haven't been generated yet. The README
already includes the `![hero](hero.svg)` embed line per contract,
expecting the SVG to land later.

**Closure expires:** 2026-07-14 (60 days from initial scaffold). Brand
artifacts get generated via the `iconography` skill (Ideogram API,
Encyclopedie etching style per dunn.dev convention). Until then this
deviation is open.
