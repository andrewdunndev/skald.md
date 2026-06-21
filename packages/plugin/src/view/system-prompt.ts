/**
 * System-prompt assembly for chat sessions.
 *
 * Four layers, composed in this order:
 *   1. Skald baseline — operating context (mobile, vault-action
 *      default); always loaded so Claude knows what kind of
 *      session this is
 *   2. Persona (vault note) — voice/personality on top of baseline;
 *      phase 9b
 *   3. Harness context (`<folder>/CLAUDE.md` + `<folder>/skills/`)
 *      — domain-specific guidance
 *   4. Memory note (vault note) — long-term state; phase 6
 *
 * Pure-ish: depends on App + plugin settings but has no view-layer
 * coupling. Extracted from view.ts as part of the LOC-cap refactor.
 */

import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import { buildMemorySection } from '../memory-prompt';
import { buildPersonaSection } from '../persona-prompt';
import { buildSkaldBaseline } from './skald-baseline';
import { buildVaultMap } from './vault-map';
import type { SkaldSettings } from '../settings';

/**
 * Hard cap (bytes) on the combined harness context (CLAUDE.md + skills/).
 * Mirrors vault-map's MAX_MAP_BYTES pattern. Without a cap, a large .claude/
 * folder sends unbounded tokens and pays full cache-creation cost on every
 * new chat and every cache expiry. ~16 KB is generous for real harness docs
 * but prevents runaway spend from accidentally oversized skill trees.
 */
export const MAX_HARNESS_BYTES = 16_384;

export async function loadSystemPrompt(
  app: App,
  settings: SkaldSettings,
): Promise<string | undefined> {
  const parts: string[] = [];

  parts.push(
    buildSkaldBaseline({
      memoryPath: settings.memoryPath,
    }),
  );

  // Vault structure — injected into the cached prefix so Claude can
  // route directly to folders/notes from turn 1. Stable within a
  // session, so it preserves the cache-hit property. Empty string
  // for an empty vault; skip in that case.
  const vaultMap = buildVaultMap(app);
  if (vaultMap) parts.push(vaultMap);

  const personaSection = await buildPersonaSection(app, {
    path: settings.activePersona,
  });
  if (personaSection) parts.push(personaSection);

  const harnessSection = await loadHarnessContext(app, settings.harnessFolder);
  if (harnessSection) parts.push(harnessSection);

  const memorySection = await buildMemorySection(app, {
    enabled: settings.memoryEnabled,
    path: settings.memoryPath,
  });
  if (memorySection) parts.push(memorySection);

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

/**
 * Load the harness folder's CLAUDE.md + skills/ tree as a single
 * system-prompt segment. Returns null when the folder isn't
 * configured or contains nothing.
 */
async function loadHarnessContext(
  app: App,
  folderSetting: string,
): Promise<string | null> {
  const f = folderSetting?.trim() ?? '';
  if (!f) return null;
  const folderPath = f === '.' || f === '/' ? '' : normalizePath(f);

  const parts: string[] = [];

  const claudeMdPath = folderPath ? `${folderPath}/CLAUDE.md` : 'CLAUDE.md';
  const claudeMd = app.vault.getAbstractFileByPath(claudeMdPath);
  if (claudeMd instanceof TFile) {
    try {
      parts.push(await app.vault.read(claudeMd));
    } catch {
      // ignore unreadable file
    }
  }

  const skillsPath = folderPath ? `${folderPath}/skills` : 'skills';
  const skillsFolder = app.vault.getAbstractFileByPath(skillsPath);
  if (skillsFolder instanceof TFolder) {
    const skills = await collectSkills(app, skillsFolder);
    if (skills.length > 0) {
      parts.push('## Skills\n\n' + skills.join('\n\n---\n\n'));
    }
  }

  if (parts.length === 0) return null;

  const joined = parts.join('\n\n---\n\n');

  if (joined.length <= MAX_HARNESS_BYTES) return joined;

  // Cap exceeded: truncate and append a clear elision marker so prompt
  // consumers can see the content was trimmed (avoids silent omission).
  return (
    joined.slice(0, MAX_HARNESS_BYTES) +
    '\n\n[... harness context truncated to cap injected tokens]'
  );
}

async function collectSkills(app: App, folder: TFolder): Promise<string[]> {
  const out: string[] = [];
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === 'md') {
      try {
        const content = await app.vault.read(child);
        out.push(`### ${child.basename}\n\n${content}`);
      } catch {
        // skip unreadable
      }
    } else if (child instanceof TFolder) {
      const nested = await collectSkills(app, child);
      out.push(...nested);
    }
  }
  return out;
}
