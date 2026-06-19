/**
 * Share-sheet capture section: where iOS-shared content lands +
 * optional custom capture prompt note.
 */

import { Setting } from 'obsidian';
import type SkaldPlugin from '../main';
import { addFolderSetting } from './folder-setting';

export function renderCaptureSection(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('Share-sheet capture').setHeading();

  addFolderSetting(containerEl, plugin, {
    name: 'Captures folder',
    desc:
      "Where captured notes land. Created on first capture if it doesn't exist. Default: Skald/Captures",
    placeholder: 'Skald/Captures',
    key: 'capturesFolder',
  });

  new Setting(containerEl)
    .setName('Custom capture prompt')
    .setDesc(
      'Vault-relative path of a markdown note whose body overrides the default capture prompt. Empty uses kind-specific defaults baked into the plugin (separate prompts for url/text/image/pdf).',
    )
    .addText((t) => {
      t.setPlaceholder('Skald/Prompts/capture.md')
        .setValue(plugin.settings.capturePromptPath)
        .onChange(async (v) => {
          plugin.settings.capturePromptPath = v.trim();
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName('Starter chips note')
    .setDesc(
      'Vault note holding the empty-state starter chips. Format: markdown list `- :icon: Label — prompt text` per line. Empty uses the baked-in defaults. Default: Skald/Starters.md',
    )
    .addText((t) => {
      t.setPlaceholder('Skald/Starters.md')
        .setValue(plugin.settings.startersPath)
        .onChange(async (v) => {
          plugin.settings.startersPath = v.trim();
          await plugin.saveSettings();
        });
    });
}
