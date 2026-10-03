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

  new Setting(containerEl)
    .setName('Allow share-sheet capture')
    .setDesc(
      'Lets the capture link send shared text to your provider and save the reply as a note, without asking. Any app or web page that can open obsidian:// links can fire it.',
    )
    .addToggle((t) =>
      t.setValue(plugin.settings.captureEnabled).onChange(async (v) => {
        plugin.settings.captureEnabled = v;
        await plugin.saveSettings();
      }),
    );

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
      'Vault-relative path of a Markdown note whose body replaces the default capture prompt. Empty uses the built-in prompt.',
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
