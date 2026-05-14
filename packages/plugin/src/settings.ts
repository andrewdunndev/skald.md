import { App, PluginSettingTab, Setting } from 'obsidian';
import type ScribianPlugin from './main';

export interface ScribianSettings {
  workerUrl: string;
  workerToken: string;
}

export const DEFAULT_SETTINGS: ScribianSettings = {
  workerUrl: '',
  workerToken: '',
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
  }
}
