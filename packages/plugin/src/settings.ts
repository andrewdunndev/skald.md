import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ScribianPlugin from './main';
import { FolderSuggest } from './folder-suggest';

export interface ScribianSettings {
  workerUrl: string;
  workerToken: string;
  anthropicApiKey: string;
  defaultModel: string;
  harnessFolder: string;
  savedNotesFolder: string;
  chatsFolder: string;
  logsFolder: string;
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
  logsFolder: '',
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

    // ── Worker ────────────────────────────────────────────────────
    new Setting(containerEl).setName('Worker').setHeading();

    new Setting(containerEl)
      .setName('Worker URL')
      .setDesc(
        'wss:// URL of your Cloudflare Worker. Run `pnpm deploy` in packages/worker to get one.',
      )
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
      .setDesc(
        'Bearer token matching the Worker secret SCRIBIAN_TOKEN. Generate with `openssl rand -hex 32`.',
      )
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('hex token')
          .setValue(this.plugin.settings.workerToken)
          .onChange(async (v) => {
            this.plugin.settings.workerToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc(
        'Hits the Worker /health endpoint. Confirms the URL is reachable; does NOT verify the token.',
      )
      .addButton((b) =>
        b
          .setButtonText('Test')
          .onClick(() => this.testWorkerHealth()),
      );

    // ── Anthropic ─────────────────────────────────────────────────
    new Setting(containerEl).setName('Anthropic').setHeading();

    new Setting(containerEl)
      .setName('API key')
      .setDesc(
        'sk-ant-… key from console.anthropic.com. Stored in plugin data, synced across your devices via Obsidian Sync. Leave blank to fall back to the Worker secret ANTHROPIC_API_KEY.',
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
      .setDesc(
        'Anthropic model used for new chats. Pickable per-chat in the chat header.',
      )
      .addDropdown((d) => {
        for (const m of MODELS) d.addOption(m.id, m.label);
        d.setValue(this.plugin.settings.defaultModel).onChange(async (v) => {
          this.plugin.settings.defaultModel = v;
          await this.plugin.saveSettings();
        });
      });

    // ── Vault integration ─────────────────────────────────────────
    new Setting(containerEl).setName('Vault integration').setHeading();

    this.addFolderSetting(
      'Harness folder',
      "Loaded as Claude's system context. Looks for `<folder>/CLAUDE.md` and `<folder>/skills/**/*.md`. Default `.claude` matches Claude Code conventions. Empty to disable.",
      '.claude',
      'harnessFolder',
    );

    this.addFolderSetting(
      'Chats folder',
      'Conversations save here as markdown after each turn. Searchable via Obsidian. Empty to disable saving.',
      'Scribian/Chats',
      'chatsFolder',
    );

    this.addFolderSetting(
      'Saved notes folder',
      'Where the "Save as note" button creates new notes from chat messages.',
      'Scribian/Saved',
      'savedNotesFolder',
    );

    this.addFolderSetting(
      'Logs folder',
      'Plugin logs (connection events, errors, tool failures) are appended to a daily file here. Empty to log to console only.',
      'Scribian/Logs',
      'logsFolder',
    );
  }

  /**
   * Render a folder-picker setting: text input with vault-folder
   * autocomplete attached. Typing filters; tap a suggestion to fill.
   */
  private addFolderSetting(
    name: string,
    desc: string,
    placeholder: string,
    key:
      | 'harnessFolder'
      | 'chatsFolder'
      | 'savedNotesFolder'
      | 'logsFolder',
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        t.setPlaceholder(placeholder).setValue(this.plugin.settings[key]);
        t.onChange(async (v) => {
          this.plugin.settings[key] = v.trim();
          await this.plugin.saveSettings();
        });
        new FolderSuggest(this.app, t.inputEl, async (folder) => {
          this.plugin.settings[key] = folder.path;
          await this.plugin.saveSettings();
        });
      });
  }

  /**
   * Hit the Worker's /health endpoint. Surface a Notice with the
   * response so users can confirm the URL is right. Does NOT validate
   * the SCRIBIAN_TOKEN — that only matters on WebSocket upgrades.
   */
  private async testWorkerHealth(): Promise<void> {
    const url = this.plugin.settings.workerUrl.trim();
    if (!url) {
      new Notice('Set the Worker URL first.');
      return;
    }
    // /health is HTTPS; the user enters wss:// in settings. Swap scheme.
    const httpUrl = url.replace(/^ws/, 'http').replace(/\/$/, '') + '/health';
    try {
      const resp = await fetch(httpUrl);
      if (!resp.ok) {
        new Notice(`Worker returned ${resp.status}`);
        return;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const aig = data.ai_gateway ? ' · AI Gateway on' : '';
      const key = data.anthropic_key_present ? ' · Worker key set' : '';
      new Notice(`Worker OK (v${data.version ?? '?'})${aig}${key}`, 5000);
    } catch (err) {
      new Notice(
        `Connection failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}
