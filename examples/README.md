# Starter content

Drop-in personas and slash commands so a fresh skald install
isn't an empty picker on first run.

## Personas

`examples/personas/*.md` — four named voices Claude can adopt. Copy
the ones you want into `Skald/Personas/` in your vault, then pick
one in Settings → Personas → Active persona.

| Name | When to use |
|---|---|
| `code-reviewer.md` | Adversarial code review. Terse, severity-led, no flattery. |
| `drill-down.md` | Root-cause investigation. Keeps asking why. |
| `editor.md` | Tighten prose. Strunk-and-White discipline. |
| `listener.md` | Reflective listening. No advice unless asked. |

Each persona file's frontmatter (`name`, `description`, `icon`) is
read by the future chat-header picker; the body becomes the
system-prompt prefix.

## Slash commands

`examples/commands/*.md` — four templates the slash-command palette
picks up. Copy into `Skald/Commands/` in your vault, then trigger
via the "Skald: Run command" command-palette entry.

| Name | Use |
|---|---|
| `summarize.md` | Three-bullet summary of the active note |
| `tag-this.md` | Suggest 3-5 Obsidian tags for the active note |
| `plan.md` | Step-by-step plan for a goal you describe |
| `critique.md` | Adversarial review of the active note's argument |

Each command's frontmatter (`name`, `description`,
`includes_active_note`) controls the picker UI + whether the active
note auto-attaches. The body is a Mustache template with these
variables available:

- `{{active_note}}` — full content of the current note, wrapped in
  `<context><file/></context>`
- `{{active_note.title}}` — just the basename
- `{{date}}` — today as YYYY-MM-DD
- `{{var|default}}` — fall through to default when no value

## Starter chips

`examples/Starters.md` — overrides the chat pane's empty-state
starter chips. Copy into `Skald/Starters.md` in your vault
(or set a custom path via Settings → Share-sheet capture →
Starter chips note).

Format per line:

```
- :icon-name: Label — full prompt text
```

The `:icon-name:` prefix is optional (Lucide icon names — same
catalog Obsidian uses). The separator can be em-dash, `--`, or
`-`. YAML frontmatter is stripped before parsing.

The chips refresh on every "new chat" — edit `Starters.md` and
the next clean pane shows the update.

## Authoring your own

Personas, commands, and starters are just markdown notes. Edit
them in Obsidian, version them with your vault, sync them across
devices for free. No plugin restart needed — the next chat start
(for personas) / next palette open (for commands) / next new
chat (for starters) picks up the change.

If you write something useful, send a PR — these examples ship in
the repo so new users find them on install.
