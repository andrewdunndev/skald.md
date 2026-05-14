import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribianPlugin from './main';

export interface ScribianSettings {
  workerUrl: string;
  workerToken: string;
  anthropicApiKey: string;
  defaultModel: string;
  harnessFolder: string;
  savedNotesFolder: string;
  chatsFolder: string;
}

export const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const DEFAULT_SETTINGS: ScribianSettings = {
  workerUrl: '',
  workerToken: '',
  anthropicApiKey: '',
  defaultModel: 'claude-sonnet-4-6',
  harnessFolder: '.claude',
  savedNotesFolder: 'Scribian/Saved',
  chatsFolder: 'Scribian/Chats',
};

export class ScribianSettingTab extends PluginSettingTab {
  plugin: ScribianPlugin;

  constructor(app: App, plugin: ScribianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Worker URL')
      .setDesc('wss:// URL of your scribian Cloudflare Worker.')
      .addText((t) =>
        t
          .setPlaceholder('wss://scribian.username.workers.dev')
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (v) => {
            this.plugin.settings.workerUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Worker token')
      .setDesc('Bearer token matching the Worker secret SCRIBIAN_TOKEN.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('paste token')
          .setValue(this.plugin.settings.workerToken)
          .onChange(async (v) => {
            this.plugin.settings.workerToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Anthropic API key')
      .setDesc(
        'sk-ant-… key. Syncs across your devices via vault sync. Leave blank to fall back to the Worker secret ANTHROPIC_API_KEY.',
      )
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-ant-…')
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (v) => {
            this.plugin.settings.anthropicApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Default model')
      .setDesc('Anthropic model used for new chats.')
      .addDropdown((d) => {
        for (const m of MODELS) d.addOption(m.id, m.label);
        d.setValue(this.plugin.settings.defaultModel).onChange(async (v) => {
          this.plugin.settings.defaultModel = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Saved notes folder')
      .setDesc(
        'Vault-relative folder where "Save as note" creates new notes from chat messages.',
      )
      .addText((t) =>
        t
          .setPlaceholder('Scribian/Saved')
          .setValue(this.plugin.settings.savedNotesFolder)
          .onChange(async (v) => {
            this.plugin.settings.savedNotesFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Chats folder')
      .setDesc(
        'Vault-relative folder where chat conversations are saved as markdown after each turn. Searchable via Obsidian. Set to empty to disable saving.',
      )
      .addText((t) =>
        t
          .setPlaceholder('Scribian/Chats')
          .setValue(this.plugin.settings.chatsFolder)
          .onChange(async (v) => {
            this.plugin.settings.chatsFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Harness folder')
      .setDesc(
        'Vault-relative folder loaded as Claude\'s system context. Looks for `<folder>/CLAUDE.md` and `<folder>/skills/**/*.md`. Default `.claude` matches Claude Code conventions. Leave blank to disable.',
      )
      .addText((t) =>
        t
          .setPlaceholder('.claude')
          .setValue(this.plugin.settings.harnessFolder)
          .onChange(async (v) => {
            this.plugin.settings.harnessFolder = v.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
