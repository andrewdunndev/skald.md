/**
 * Build the long-term memory section that gets injected into Claude's
 * system prompt at the start of every chat (phase 6). The memory note
 * is a single user-editable vault note that Claude reads inline and
 * proposes updates to via the standard write_note / edit_note flow
 * (user approval required via diff card).
 *
 * Extracted from view.ts to keep the system-prompt assembly there
 * focused on coordination — the actual memory shape is a domain
 * concept that lives here.
 */

import { TFile, normalizePath, type App } from 'obsidian';

export interface MemorySectionInput {
  enabled: boolean;
  path: string;
}

/** Byte threshold past which the system prompt adds a consolidation
 * nudge. Tuned to roughly "a memory note that's still reasonable to
 * inject every turn." Past this size, Claude's per-turn input cost
 * climbs noticeably, AND human users start losing track of what's in
 * there. The nudge is non-destructive — it asks Claude to propose
 * a consolidation pass; the user approves via diff card. */
export const MEMORY_PRUNE_THRESHOLD_BYTES = 4 * 1024;

/**
 * Return the memory block as a system-prompt-ready string, or null
 * if the memory feature is disabled or unconfigured. The caller
 * concatenates this with other system-prompt segments. When memory
 * exceeds MEMORY_PRUNE_THRESHOLD_BYTES, a consolidation-nudge
 * paragraph appears in the section so Claude can suggest a prune
 * at a natural moment.
 */
export async function buildMemorySection(
  app: App,
  input: MemorySectionInput,
): Promise<string | null> {
  const path = input.path?.trim() ?? '';
  if (!input.enabled || !path) return null;

  const body = await readMemoryNote(app, path);
  const bytes = byteLength(body);
  const lines: string[] = [
    '## Long-term memory',
    '',
    `You have a long-term memory note at \`${path}\` that persists`,
    'across chat sessions. The current contents are below. When the user',
    'asks you to remember something, or when you decide a fact is worth',
    'persisting long-term, propose an update via `write_note` or',
    '`edit_note` targeting this exact path. The user will approve via a',
    'diff card before anything is written.',
    '',
    '<memory>',
    body.trim() === '' ? '(empty — no memories saved yet)' : body,
    '</memory>',
  ];
  if (bytes > MEMORY_PRUNE_THRESHOLD_BYTES) {
    lines.push(
      '',
      `NOTE: This memory note has grown to ${(bytes / 1024).toFixed(1)} KB. At a natural moment in this conversation, consider proposing a consolidation pass via \`write_note\`: group related facts, drop ones the user has marked obsolete, and tighten phrasing. User approves via the diff card. Don't interrupt the user's current question to do this — wait for a lull.`,
    );
  }
  return lines.join('\n');
}

function byteLength(s: string): number {
  // Browsers + Workers have TextEncoder; this counts UTF-8 bytes
  // (the actual on-disk + over-wire cost), not JS string length
  // which counts UTF-16 code units.
  return new TextEncoder().encode(s).length;
}

async function readMemoryNote(app: App, path: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) return '';
  try {
    return await app.vault.cachedRead(file);
  } catch {
    return '';
  }
}
