/**
 * Slash-commands section: folder where user-authored command notes
 * live. Each command is a markdown note with a Mustache template
 * body; "Skald: Insert prompt template" opens the picker.
 */

import { Setting } from 'obsidian';
import type SkaldPlugin from '../main';
import { addFolderSetting } from './folder-setting';

export function renderCommandsSection(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('Prompt templates').setHeading();
  void plugin;

  addFolderSetting(containerEl, plugin, {
    name: 'Commands folder',
    desc:
      'Where prompt template notes live. Each template is a markdown note; the body is a Mustache template expanded into the chat input when picked. Run via the "Skald: Insert prompt template" command-palette entry. Default: Skald/Commands',
    placeholder: 'Skald/Commands',
    key: 'commandsFolder',
  });
}
