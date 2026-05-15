/**
 * System-prompt assembly for chat sessions.
 *
 * Three optional layers, composed in this order so domain guidance
 * builds on top of the persona's voice:
 *   1. Persona (vault note) — phase 9b
 *   2. Harness context (`<folder>/CLAUDE.md` + `<folder>/skills/`)
 *   3. Memory note (vault note) — phase 6
 *
 * Pure-ish: depends on App + plugin settings but has no view-layer
 * coupling. Extracted from view.ts as part of the LOC-cap refactor.
 */

import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import { buildMemorySection } from '../memory-prompt';
import { buildPersonaSection } from '../persona-prompt';
import type { ScribianSettings } from '../settings';

export async function loadSystemPrompt(
  app: App,
  settings: ScribianSettings,
): Promise<string | undefined> {
  const parts: string[] = [];

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

  return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
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
