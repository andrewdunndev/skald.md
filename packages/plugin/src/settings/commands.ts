/**
 * Slash-commands section: folder where user-authored command notes
 * live. Each command is a markdown note with a Mustache template
 * body; "Scribian: Run command" opens the picker.
 */

import { Setting } from 'obsidian';
import type ScribianPlugin from '../main';
import { addFolderSetting } from './folder-setting';

export function renderCommandsSection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
): void {
  new Setting(containerEl).setName('Slash commands').setHeading();
  void plugin;

  addFolderSetting(containerEl, plugin, {
    name: 'Commands folder',
    desc:
      'Where command notes live. Each command is a markdown note; the body is a Mustache template expanded into the chat input when picked. Run via the "Scribian: Run command" command-palette entry. Default: Scribian/Commands',
    placeholder: 'Scribian/Commands',
    key: 'commandsFolder',
  });
}
