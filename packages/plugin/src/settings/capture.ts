/**
 * Share-sheet capture section: where iOS-shared content lands +
 * optional custom capture prompt note.
 */

import { Setting } from 'obsidian';
import type SkaldPlugin from '../main';
import { modeCapabilities } from '../mode-capabilities';
import { addFolderSetting } from './folder-setting';

export function renderCaptureSection(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('Share-sheet capture').setHeading();

  const caps = modeCapabilities(plugin.settings.connectionMode);
  const routingDesc = caps.semanticSearch
    ? "Auto-route runs find_related on the generated capture note and appends to a matching vault note when similarity is high (score ≥ 0.85). Falls back to creating in the captures folder when no good match exists. Inbox always creates in the folder regardless."
    : "Auto-route requires Worker mode (semantic search is unavailable in direct mode). Captures always land in the captures folder in direct mode.";

  const routingSetting = new Setting(containerEl)
    .setName('Capture routing')
    .setDesc(routingDesc)
    .addDropdown((d) => {
      // In direct mode, only inbox is available — auto-route needs Vectorize.
      if (caps.semanticSearch) {
        d.addOption('auto-route', 'Auto-route to best matching note');
      }
      d.addOption('inbox', 'Always create in captures folder')
        .setValue(caps.semanticSearch ? plugin.settings.captureMode : 'inbox')
        .onChange(async (v) => {
          plugin.settings.captureMode = v === 'inbox' ? 'inbox' : 'auto-route';
          await plugin.saveSettings();
        });
      if (!caps.semanticSearch) d.setDisabled(true);
    });
  void routingSetting;

  addFolderSetting(containerEl, plugin, {
    name: 'Captures folder',
    desc:
      "Where captured notes land (always for inbox mode; as fallback for auto-route when no good match exists). Created on first capture if it doesn't exist. Default: Skald/Captures",
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
