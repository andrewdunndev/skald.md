/**
 * Personas section: vault folder where persona notes live + which
 * one is currently active. Personas are markdown notes whose body
 * (frontmatter stripped) prefixes the system prompt.
 */

import { Setting } from 'obsidian';
import type ScribianPlugin from '../main';
import { addFolderSetting } from './folder-setting';

export function renderPersonasSection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
): void {
  new Setting(containerEl).setName('Personas').setHeading();

  addFolderSetting(containerEl, plugin, {
    name: 'Personas folder',
    desc:
      'Where persona notes live. Each persona is a markdown note; its body (frontmatter stripped) becomes a system-prompt prefix when active. Default: Scribian/Personas',
    placeholder: 'Scribian/Personas',
    key: 'personasFolder',
  });

  new Setting(containerEl)
    .setName('Active persona')
    .setDesc(
      'Vault-relative path of the active persona note (e.g. "Scribian/Personas/code-reviewer.md"). Empty to disable. The persona\'s body prefixes Claude\'s system prompt on every chat.',
    )
    .addText((t) => {
      t.setPlaceholder('Scribian/Personas/code-reviewer.md')
        .setValue(plugin.settings.activePersona)
        .onChange(async (v) => {
          plugin.settings.activePersona = v.trim();
          await plugin.saveSettings();
        });
    });
}
