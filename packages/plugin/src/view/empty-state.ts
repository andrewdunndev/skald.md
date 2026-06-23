import { TFile, normalizePath, setIcon, type App } from 'obsidian';

export interface StarterChip {
  /** Lucide icon name (or null for no icon). */
  icon: string | null;
  /** Short label shown on the chip. */
  label: string;
  /** Full prompt text that lands in the input on tap. */
  prompt: string;
  /** When true, the host should also open the image picker after
   * filling the prompt — turning the chip into a one-tap "open
   * camera with prompt staged" action. Used by the default
   * "Identify + file" chip; configurable via Starters.md with the
   * `+image` suffix on the label half (see parseStartersNote). */
  attachImage?: boolean;
}

export interface EmptyStateHooks {
  /** Called when the user taps a starter chip. The host fills the
   * composer with the chip's prompt — the user reviews + sends in
   * the normal flow. The full chip is passed so the host can react
   * to flags like attachImage. */
  onChipPick: (chip: StarterChip) => void;
}

/**
 * Default starter chips. Tuned for the mobile-second-brain context:
 * skald's value-add over Apple Intelligence / ChatGPT is that
 * the OUTPUT lands in the user's vault. Every starter leans into
 * "AI → vault action" rather than "AI → answer in a transient
 * chat window." Mirrors the example use case: "what is this flower,
 * add it to my flower list."
 *
 * Authors who want a different default set can override via the
 * `chips` argument to renderEmptyState.
 */
export const DEFAULT_STARTER_CHIPS: StarterChip[] = [
  {
    icon: 'camera',
    label: 'What is this?',
    prompt:
      "Identify what's in this image, then find the most relevant note in my vault and propose an append. If no good fit exists, propose a new note.",
    attachImage: true,
  },
  {
    icon: 'pencil-line',
    label: 'Save a thought',
    prompt:
      "I have a thought to capture. After I describe it, propose where it should land in my vault (existing note + append, or a new note with a sensible path). I'll approve the write.",
  },
  {
    icon: 'list-checks',
    label: 'Catch up on TODOs',
    prompt:
      "Scan my vault for unresolved items, dangling questions, and TODOs I haven't followed up on. List them grouped by note, newest first.",
  },
  {
    icon: 'brain',
    label: 'Remember this',
    prompt:
      "I'm going to tell you something I want you to remember long-term. Add it to my memory note — I'll approve the change.",
  },
  {
    icon: 'split',
    label: 'Think it through',
    prompt:
      "I'm thinking through a decision. Ask me what I'm weighing, pull related notes from my vault as context, and help me reason about it. Offer to save the conclusion when we land.",
  },
];

/**
 * Parse a Starters.md vault note into a chip list. Format mirrors
 * what an Obsidian power user would naturally write — a markdown
 * list where each item is `- :icon-name: Label — prompt text`, or
 * with the icon omitted: `- Label — prompt text`. The em-dash OR
 * a regular double-hyphen separates label from prompt. YAML
 * frontmatter is stripped before parsing.
 *
 * Returns an empty array on parse failure / missing file — the
 * caller falls back to DEFAULT_STARTER_CHIPS.
 *
 * The icon syntax `:list-checks:` uses Lucide names (same as
 * Obsidian's setIcon catalog).
 */
export function parseStartersNote(body: string): StarterChip[] {
  const stripped = stripFrontmatter(body);
  const out: StarterChip[] = [];
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const item = line.slice(2).trim();
    // Split on em-dash OR " -- " OR " - " (last wins; treat first
    // such separator as the label/prompt boundary).
    const sep = item.search(/\s+(?:—|--|-)\s+/);
    if (sep < 0) continue;
    let labelHalf = item.slice(0, sep).trim();
    const promptHalf = item.slice(sep).replace(/^\s+(?:—|--|-)\s+/, '').trim();
    if (!promptHalf) continue;
    // Optional [image] flag — when present in the label half, the
    // host opens the image picker after filling the prompt (one-tap
    // "camera + prompt staged" action).
    let attachImage = false;
    const imageFlag = labelHalf.match(/\s*\[image\]\s*$/i);
    if (imageFlag) {
      attachImage = true;
      labelHalf = labelHalf.slice(0, imageFlag.index).trim();
    }
    // Optional :icon-name: prefix on the label half.
    const iconMatch = labelHalf.match(/^:([a-z0-9-]+):\s*(.*)$/i);
    const icon = iconMatch ? iconMatch[1] : null;
    const label = (iconMatch ? iconMatch[2] : labelHalf).trim();
    if (!label) continue;
    const chip: StarterChip = { icon, label, prompt: promptHalf };
    if (attachImage) chip.attachImage = true;
    out.push(chip);
  }
  return out;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

/**
 * Load starter chips from a vault note. The note's path is
 * configurable (defaults to `Skald/Starters.md`). Returns the
 * default chip list when the note is missing, empty, or parses
 * to no chips — keeping the empty state useful out of the box.
 */
export async function loadStarterChips(
  app: App,
  path: string,
): Promise<StarterChip[]> {
  const trimmed = path?.trim() ?? '';
  if (!trimmed) return DEFAULT_STARTER_CHIPS;
  const normalized = normalizePath(trimmed);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) return DEFAULT_STARTER_CHIPS;
  try {
    const body = await app.vault.cachedRead(file);
    const parsed = parseStartersNote(body);
    if (parsed.length === 0) {
      // File exists but parsed to zero chips — most likely a format
      // issue (no list items, all separators missing). Surface this
      // so the user knows why their custom starters aren't showing
      // instead of silently falling back.
      console.warn(
        `skald: starters note at ${normalized} parsed to zero chips — check the list format (\`- :icon: Label — prompt\` per line). Using defaults.`,
      );
      return DEFAULT_STARTER_CHIPS;
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `skald: failed to load starters at ${normalized}: ${msg}. Using defaults.`,
    );
    return DEFAULT_STARTER_CHIPS;
  }
}

/**
 * Render an empty-state welcome into the messages container. Shown
 * when the chat has no messages — the host removes it on first
 * message arrival.
 *
 * The element is returned so the host can stash it and remove it
 * imperatively; container.empty() also works when the list rebuilds.
 */
export function renderEmptyState(
  parent: HTMLElement,
  hooks: EmptyStateHooks,
  chips: StarterChip[] = DEFAULT_STARTER_CHIPS,
): HTMLDivElement {
  const wrap = parent.createDiv({ cls: 'skald-empty' });

  // Icon is purely decorative — the heading below is the accessible name (D).
  const icon = wrap.createDiv({ cls: 'skald-empty-icon' });
  icon.setAttr('aria-hidden', 'true');
  setIcon(icon, 'sparkles');

  // Real heading element so AT can navigate via heading shortcuts (F).
  wrap.createEl('h2', {
    cls: 'skald-empty-title',
    text: 'Your vault, on call.',
  });

  wrap.createEl('p', {
    cls: 'skald-empty-subtitle',
    text:
      'Tap a starter, type a question, or attach notes with @ to give Claude context.',
  });

  const chipRow = wrap.createDiv({ cls: 'skald-empty-chips' });
  renderChipsInto(chipRow, chips, hooks.onChipPick);

  return wrap;
}

/**
 * Re-render a chip row in place. Used when the host loads starter
 * chips asynchronously from the vault and wants to swap them in
 * after the initial defaults rendered.
 */
export function renderChipsInto(
  chipRow: HTMLElement,
  chips: StarterChip[],
  onChipPick: (chip: StarterChip) => void,
): void {
  chipRow.empty();
  for (const chip of chips) {
    const btn = chipRow.createEl('button', {
      cls: 'skald-empty-chip',
      attr: { type: 'button' },
    });
    if (chip.icon) {
      // Icon is decorative — the chip label span is the button text (D).
      const ic = btn.createSpan({ cls: 'skald-empty-chip-icon' });
      ic.setAttr('aria-hidden', 'true');
      setIcon(ic, chip.icon);
    }
    btn.createSpan({ cls: 'skald-empty-chip-label', text: chip.label });
    btn.addEventListener('click', () => onChipPick(chip));
  }
}
