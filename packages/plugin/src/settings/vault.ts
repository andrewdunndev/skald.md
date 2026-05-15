/**
 * Vault-integration section: folder pickers for harness context,
 * chat persistence, saved notes, log files.
 */

import { Setting } from 'obsidian';
import type ScribianPlugin from '../main';
import { addFolderSetting } from './folder-setting';

export function renderVaultSection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
): void {
  new Setting(containerEl).setName('Vault integration').setHeading();

  addFolderSetting(containerEl, plugin, {
    name: 'Harness folder',
    desc:
      "Loaded as Claude's system context. Looks for `<folder>/CLAUDE.md` and `<folder>/skills/**/*.md`. Default `.claude` matches Claude Code conventions. Empty to disable.",
    placeholder: '.claude',
    key: 'harnessFolder',
  });

  addFolderSetting(containerEl, plugin, {
    name: 'Chats folder',
    desc:
      'Conversations save here as markdown after each turn. Searchable via Obsidian. Empty to disable saving.',
    placeholder: 'Scribian/Chats',
    key: 'chatsFolder',
  });

  addFolderSetting(containerEl, plugin, {
    name: 'Saved notes folder',
    desc:
      'Where the "Save as note" button creates new notes from chat messages.',
    placeholder: 'Scribian/Saved',
    key: 'savedNotesFolder',
  });

  addFolderSetting(containerEl, plugin, {
    name: 'Logs folder',
    desc:
      'Plugin logs (connection events, errors, tool failures) are appended to a daily file here. Empty to log to console only.',
    placeholder: 'Scribian/Logs',
    key: 'logsFolder',
  });
}
