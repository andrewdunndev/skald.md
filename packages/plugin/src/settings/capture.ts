/**
 * Share-sheet capture section: where iOS-shared content lands +
 * optional custom capture prompt note.
 */

import { Setting } from 'obsidian';
import type ScribianPlugin from '../main';
import { addFolderSetting } from './folder-setting';

export function renderCaptureSection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
): void {
  new Setting(containerEl).setName('Share-sheet capture').setHeading();

  addFolderSetting(containerEl, plugin, {
    name: 'Captures folder',
    desc:
      "Where captured notes from the iOS share-sheet land. Created on first capture if it doesn't exist. Default: Scribian/Captures",
    placeholder: 'Scribian/Captures',
    key: 'capturesFolder',
  });

  new Setting(containerEl)
    .setName('Custom capture prompt')
    .setDesc(
      'Vault-relative path of a markdown note whose body overrides the default capture prompt. Empty uses kind-specific defaults baked into the plugin (separate prompts for url/text/image/pdf).',
    )
    .addText((t) => {
      t.setPlaceholder('Scribian/Prompts/capture.md')
        .setValue(plugin.settings.capturePromptPath)
        .onChange(async (v) => {
          plugin.settings.capturePromptPath = v.trim();
          await plugin.saveSettings();
        });
    });
}
