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

/**
 * Return the memory block as a system-prompt-ready string, or null
 * if the memory feature is disabled or unconfigured. The caller
 * concatenates this with other system-prompt segments.
 */
export async function buildMemorySection(
  app: App,
  input: MemorySectionInput,
): Promise<string | null> {
  const path = input.path?.trim() ?? '';
  if (!input.enabled || !path) return null;

  const body = await readMemoryNote(app, path);
  return [
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
  ].join('\n');
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
