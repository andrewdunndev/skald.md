---
description: Empty-state starter chips for skald's chat pane.
note: |
  Copy this to your vault as `Skald/Starters.md` (or any path,
  pointed at via Settings → Share-sheet capture → Starter chips note).
  Each list item below becomes a tap-to-fill chip on the chat
  pane's empty state. Format per line:

    - :icon-name: Label — full prompt text

  - `:icon-name:` is optional; uses Lucide icon names (same as
    Obsidian's setIcon catalog).
  - The separator can be em-dash (—), `--`, or `-`.
  - Append `[image]` to a label (before the separator) to make the
    chip auto-open the image picker after filling the prompt —
    one-tap "camera + prompt staged."
  - Empty prompts are dropped.
  - YAML frontmatter (this block) is stripped before parsing.

  Tune these to YOUR vault. The defaults baked into the plugin are
  generic; the whole point of pointing at a vault note is to
  surface starters that match how YOU work.
---

- :camera: Identify + file [image] — Identify what's in this image, then find the most relevant note in my vault and propose an append (use find_related first if you're not sure which note fits). If no good fit exists, propose a new note.
- :pencil-line: Capture this idea — I have a thought to capture. After I describe it, propose where it should land in my vault (existing note + append, or a new note with a sensible path). Use find_related to check first. I'll approve via the diff card.
- :list-checks: What's loose? — Scan my vault for unresolved items, dangling questions, and TODOs I haven't followed up on. List them grouped by note, newest first.
- :brain: Remember this — I'm going to tell you something I want you to remember long-term. Use remember_fact to add it to my memory note — I'll approve via the diff card.
- :split: Talk it out — I'm thinking through a decision. Ask me what I'm weighing, pull related notes from my vault as context, and help me reason about it. Offer to capture the conclusion to a note when we land.
