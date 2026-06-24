/**
 * Shared folder-picker setting renderer. Attaches FolderSuggest
 * (vault-folder autocomplete) to a text input so users can type to
 * filter without remembering paths.
 *
 * Lives in settings/ (not at module root) because it's only used by
 * the per-section settings renderers; nothing outside settings needs
 * it.
 */

import { Setting } from 'obsidian';
import type SkaldPlugin from '../main';
import { FolderSuggest } from '../folder-suggest';

/** Subset of SkaldSettings keys that hold a folder path. */
export type FolderSettingKey =
  | 'harnessFolder'
  | 'chatsFolder'
  | 'savedNotesFolder'
  | 'logsFolder'
  | 'commandsFolder'
  | 'capturesFolder';

export function addFolderSetting(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
  args: {
    name: string;
    desc: string;
    placeholder: string;
    key: FolderSettingKey;
  },
): void {
  new Setting(containerEl)
    .setName(args.name)
    .setDesc(args.desc)
    .addText((t) => {
      t.setPlaceholder(args.placeholder).setValue(
        plugin.settings[args.key] as string,
      );
      t.onChange(async (v) => {
        (plugin.settings[args.key] as unknown as string) = v.trim();
        await plugin.saveSettings();
      });
      new FolderSuggest(plugin.app, t.inputEl, async (folder) => {
        (plugin.settings[args.key] as unknown as string) = folder.path;
        await plugin.saveSettings();
      });
    });
}
