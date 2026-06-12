/**
 * Memory section: long-term memory note + semantic-search reindex.
 *
 * The toggle gates whether scribian injects the memory note's body
 * into the system prompt at chat start. The path is the single
 * vault note Claude is told it can read + (with approval) update.
 * The reindex button drives the manifest-diff incremental sync that
 * powers find_related — it is only available in Worker mode because
 * it requires the Worker's Vectorize binding. Pass usesWorker=false
 * to render a disabled/explanatory state instead.
 */

import { Setting } from 'obsidian';
import type ScribianPlugin from '../main';

export function renderMemorySection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
  opts: { usesWorker: boolean } = { usesWorker: true },
): void {
  new Setting(containerEl).setName('Memory').setHeading();

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

  if (opts.usesWorker) {
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
