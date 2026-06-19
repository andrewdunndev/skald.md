/**
 * Memory settings, split across the two disclosure tiers:
 * the enable toggle is a core (always-visible) item; the note path
 * lives in the Advanced section.
 */

import { Setting } from 'obsidian';
import type SkaldPlugin from '../main';

/** Core tier: just the enable toggle. */
export function renderMemoryToggle(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl)
    .setName('Enable memory note')
    .setDesc(
      "Inject a single vault note's contents into every chat's system prompt as Claude's long-term memory. Claude can read it inline and propose updates via write_note / edit_note (you approve via diff card).",
    )
    .addToggle((t) =>
      t.setValue(plugin.settings.memoryEnabled).onChange(async (v) => {
        plugin.settings.memoryEnabled = v;
        await plugin.saveSettings();
      }),
    );
}

/** Advanced tier: note path. */
export function renderMemoryAdvanced(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('Memory').setHeading();

  new Setting(containerEl)
    .setName('Memory note path')
    .setDesc(
      'Vault-relative path of the memory note. Created on first write if it does not exist. Default: Skald/Memory.md',
    )
    .addText((t) => {
      t.setPlaceholder('Skald/Memory.md')
        .setValue(plugin.settings.memoryPath)
        .onChange(async (v) => {
          plugin.settings.memoryPath = v.trim();
          await plugin.saveSettings();
        });
    });
}
