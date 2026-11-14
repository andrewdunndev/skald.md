# Deviations from dunn.dev/reference

House-standard exceptions for the maintainer's own repo checks; nothing here affects users or contributors.

Each entry: which contract check fails and why. An entry stands until
it is closed or removed from this file.

## design-system: skipped (permanent)

**What fails:** no `@dunn.dev/reference` tokens import in any
`global.css` or `package.json`.

**Why:** skald is an Obsidian community plugin, not a web project. It
uses Obsidian's CSS variables (`--background-primary`, `--text-normal`,
`--interactive-accent`) so it respects the user's installed theme.
Hard-coded tokens would conflict with it.

## pipeline: no catalog component

**What fails:** `.gitlab-ci.yml` references no
`gitlab.com/dunn.dev/pipeline/<component>` catalog component.

**Why:** the CI is hand-rolled (typecheck, lint, tests, plugin build)
because the catalog has no TypeScript/Node build component yet.
