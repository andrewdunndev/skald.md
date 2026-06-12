/**
 * Memory settings, split across the two disclosure tiers:
 * the enable toggle is a core (always-visible) item; the note path
 * and semantic-search reindex live in the Advanced section. Reindex
 * requires the Worker's Vectorize binding, so in direct mode it
 * renders disabled with an explanation rather than disappearing.
 */

import { Setting } from 'obsidian';
import type ScribianPlugin from '../main';

/** Core tier: just the enable toggle. */
export function renderMemoryToggle(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
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

/** Advanced tier: note path + reindex. */
export function renderMemoryAdvanced(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
  usesWorker: boolean,
): void {
  new Setting(containerEl).setName('Memory').setHeading();

  new Setting(containerEl)
    .setName('Memory note path')
    .setDesc(
      'Vault-relative path of the memory note. Created on first write if it does not exist. Default: Scribian/Memory.md',
    )
    .addText((t) => {
      t.setPlaceholder('Scribian/Memory.md')
        .setValue(plugin.settings.memoryPath)
        .onChange(async (v) => {
          plugin.settings.memoryPath = v.trim();
          await plugin.saveSettings();
        });
    });

  if (usesWorker) {
    new Setting(containerEl)
      .setName('Reindex vault for semantic search')
      .setDesc(
        "Walk markdown notes (excluding chats/logs/saved folders), embed each via Workers AI, upsert to the Worker's Vectorize index. Required before find_related works. Re-run after major vault changes. Cost: ~one cent per 1000 notes.",
      )
      .addButton((b) =>
        b.setButtonText('Reindex').onClick(() => {
          void plugin.reindexVault();
        }),
      );
  } else {
    new Setting(containerEl)
      .setName('Reindex vault for semantic search')
      .setDesc(
        'Requires Worker mode — semantic search uses the Worker\'s Vectorize binding which is unavailable in direct mode. Switch to Worker mode to enable reindexing.',
      )
      .addButton((b) =>
        b.setButtonText('Reindex').setDisabled(true),
      );
  }
}
