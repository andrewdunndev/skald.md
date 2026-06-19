/**
 * Build the persona section that gets injected into Claude's system
 * prompt at the start of every chat (phase 9b).
 *
 * A persona is a single vault note whose body becomes a system-
 * prompt prefix. Users author their own ("code-reviewer.md",
 * "drill-down.md", "therapist.md") in a configurable folder
 * (default Skald/Personas/) and pick one in settings. The
 * persona's frontmatter is stripped before injection so the user
 * can keep YAML metadata without it leaking into the prompt.
 *
 * Mirrors memory-prompt.ts in shape — both take an
 * application + (enabled? path) tuple and return a string or null.
 * Both are composed by view.ts loadSystemPrompt into the final
 * system block, in this order:
 *   persona → harness context → memory
 *
 * Persona before harness lets the persona override Claude's
 * default voice; harness context (CLAUDE.md + skills) then layers
 * domain-specific guidance on top.
 */

import { TFile, normalizePath, type App } from 'obsidian';

export interface PersonaSectionInput {
  /** Vault-relative path of the active persona note. Empty → no
   * persona, returns null. */
  path: string;
}

export async function buildPersonaSection(
  app: App,
  input: PersonaSectionInput,
): Promise<string | null> {
  const path = input.path?.trim() ?? '';
  if (!path) return null;

  const body = await readPersonaNote(app, path);
  if (!body) return null;
  const stripped = stripFrontmatter(body).trim();
  if (!stripped) return null;
  return stripped;
}

async function readPersonaNote(app: App, path: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) return '';
  try {
    return await app.vault.cachedRead(file);
  } catch {
    return '';
  }
}

/**
 * Strip a leading YAML frontmatter block if present. Persona notes
 * may carry metadata (description, icon, etc. that the future
 * persona picker UI will read) — only the body becomes the system
 * prompt.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}
