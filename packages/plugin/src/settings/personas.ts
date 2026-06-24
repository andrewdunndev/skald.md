/**
 * Personas section: which persona note is currently active. Personas
 * are markdown notes whose body (frontmatter stripped) prefixes the
 * system prompt.
 */

import { Setting } from 'obsidian';
import type SkaldPlugin from '../main';

export function renderPersonasSection(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('Personas').setHeading();

  new Setting(containerEl)
    .setName('Active persona')
    .setDesc(
      'Vault-relative path of the active persona note (e.g. "Skald/Personas/code-reviewer.md"). Empty to disable. The persona\'s body prefixes Claude\'s system prompt on every chat.',
    )
    .addText((t) => {
      t.setPlaceholder('Skald/Personas/code-reviewer.md')
        .setValue(plugin.settings.activePersona)
        .onChange(async (v) => {
          plugin.settings.activePersona = v.trim();
          await plugin.saveSettings();
        });
    });
}
