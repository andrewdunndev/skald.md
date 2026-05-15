import { setIcon } from 'obsidian';

export interface StarterChip {
  /** Lucide icon name (or null for no icon). */
  icon: string | null;
  /** Short label shown on the chip. */
  label: string;
  /** Full prompt text that lands in the input on tap. */
  prompt: string;
}

export interface EmptyStateHooks {
  /** Called when the user taps a starter chip. The host fills the
   * composer with the chip's prompt — the user reviews + sends in
   * the normal flow. */
  onChipPick: (prompt: string) => void;
}

/**
 * Default starter chips. Tuned for the mobile-second-brain context:
 * scribian's value-add over Apple Intelligence / ChatGPT is that
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
    label: 'Identify + file',
    prompt:
      "I'm going to attach an image. Identify what's in it, then find the most relevant note in my vault and propose an append (use find_related first if you're not sure which note fits). If no good fit exists, propose a new note.",
  },
  {
    icon: 'pencil-line',
    label: 'Capture this idea',
    prompt:
      "I have a thought to capture. After I describe it, propose where it should land in my vault (existing note + append, or a new note with a sensible path). Use find_related to check first. I'll approve via the diff card.",
  },
  {
    icon: 'list-checks',
    label: "What's loose?",
    prompt:
      "Scan my vault for unresolved items, dangling questions, and TODOs I haven't followed up on. List them grouped by note, newest first.",
  },
  {
    icon: 'brain',
    label: 'Remember this',
    prompt:
      "I'm going to tell you something I want you to remember long-term. Use remember_fact to add it to my memory note — I'll approve via the diff card.",
  },
  {
    icon: 'split',
    label: 'Talk it out',
    prompt:
      "I'm thinking through a decision. Ask me what I'm weighing, pull related notes from my vault as context, and help me reason about it. Offer to capture the conclusion to a note when we land.",
  },
];

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
  const wrap = parent.createDiv({ cls: 'scribian-empty' });

  const icon = wrap.createDiv({ cls: 'scribian-empty-icon' });
  setIcon(icon, 'sparkles');

  wrap.createEl('div', {
    cls: 'scribian-empty-title',
    text: 'Your vault, on call.',
  });

  wrap.createEl('div', {
    cls: 'scribian-empty-subtitle',
    text:
      'Tap a starter, type a question, or attach notes with @ to give Claude context.',
  });

  const chipRow = wrap.createDiv({ cls: 'scribian-empty-chips' });
  for (const chip of chips) {
    const btn = chipRow.createEl('button', {
      cls: 'scribian-empty-chip',
      attr: { type: 'button' },
    });
    if (chip.icon) {
      const ic = btn.createSpan({ cls: 'scribian-empty-chip-icon' });
      setIcon(ic, chip.icon);
    }
    btn.createSpan({ cls: 'scribian-empty-chip-label', text: chip.label });
    btn.addEventListener('click', () => hooks.onChipPick(chip.prompt));
  }

  return wrap;
}
