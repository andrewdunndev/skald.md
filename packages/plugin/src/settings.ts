import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribianPlugin from './main';

export interface ScribianSettings {
  workerUrl: string;
  workerToken: string;
  defaultModel: string;
  systemPromptPath: string;
}

export const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const DEFAULT_SETTINGS: ScribianSettings = {
  workerUrl: '',
  workerToken: '',
  defaultModel: 'claude-sonnet-4-6',
  systemPromptPath: 'CLAUDE.md',
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
      .setName('System prompt note')
      .setDesc(
        'Vault-relative path to a markdown note loaded as system prompt. Leave blank to disable.',
      )
      .addText((t) =>
        t
          .setPlaceholder('CLAUDE.md')
          .setValue(this.plugin.settings.systemPromptPath)
          .onChange(async (v) => {
            this.plugin.settings.systemPromptPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
