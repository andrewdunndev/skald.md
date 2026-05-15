import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { Provider } from '@scribian/protocol';
import type ScribianPlugin from './main';
import { FolderSuggest } from './folder-suggest';
import { ModelSuggest } from './model-suggest';

export interface ScribianSettings {
  workerUrl: string;
  workerToken: string;
  /**
   * Active provider. Anthropic-direct is the default (rich content
   * blocks, native server tools, prompt caching). OpenRouter is the
   * opt-in fallback for non-Anthropic models via the namespaced
   * catalog.
   */
  provider: Provider;
  anthropicApiKey: string;
  openrouterApiKey: string;
  /** Default Anthropic model (used when provider=anthropic). */
  defaultModel: string;
  /** Default OpenRouter model id (used when provider=openrouter).
   * Catalog ids are slash-namespaced: `anthropic/claude-...`,
   * `openai/...`, `meta-llama/...`, etc. */
  openrouterModel: string;
  harnessFolder: string;
  savedNotesFolder: string;
  chatsFolder: string;
  logsFolder: string;
  /**
   * Phase 6: vault-as-memory.
   * memoryEnabled: inject memoryPath contents into the system prompt
   *   at the start of every chat. Claude can read + (with approval)
   *   write to this note across sessions for long-term state.
   * memoryPath: the single note holding Claude's memory. Defaults
   *   to Scribian/Memory.md.
   */
  memoryEnabled: boolean;
  memoryPath: string;
  /**
   * Phase 9b: personas.
   * personasFolder: where the user keeps persona notes. Surfaces
   *   the "[Open personas folder]" button in settings.
   * activePersona: vault-relative path of the active persona note.
   *   Empty → no persona. The note's body (frontmatter stripped)
   *   prefixes the system prompt.
   */
  personasFolder: string;
  activePersona: string;
  /**
   * Phase 9a: slash commands.
   * commandsFolder: where the user keeps slash-command notes. Each
   *   note is a Mustache-style template expanded + dropped into the
   *   chat input when picked from the modal.
   */
  commandsFolder: string;
}

export const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const DEFAULT_SETTINGS: ScribianSettings = {
  workerUrl: '',
  workerToken: '',
  provider: 'anthropic',
  anthropicApiKey: '',
  openrouterApiKey: '',
  defaultModel: 'claude-sonnet-4-6',
  openrouterModel: 'anthropic/claude-sonnet-4-6',
  harnessFolder: '.claude',
  savedNotesFolder: 'Scribian/Saved',
  chatsFolder: 'Scribian/Chats',
  logsFolder: '',
  memoryEnabled: true,
  memoryPath: 'Scribian/Memory.md',
  personasFolder: 'Scribian/Personas',
  activePersona: '',
  commandsFolder: 'Scribian/Commands',
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

    // ── Provider ──────────────────────────────────────────────────
    new Setting(containerEl).setName('Provider').setHeading();

    new Setting(containerEl)
      .setName('Active provider')
      .setDesc(
        'Anthropic (direct): rich content blocks, native server tools, prompt caching. OpenRouter: fallback for non-Anthropic models via OpenRouter\'s Anthropic-compatible endpoint.',
      )
      .addDropdown((d) => {
        d.addOption('anthropic', 'Anthropic (direct)');
        d.addOption('openrouter', 'OpenRouter (fallback)');
        d.setValue(this.plugin.settings.provider).onChange(async (v) => {
          this.plugin.settings.provider = v as Provider;
          await this.plugin.saveSettings();
          // Re-render to show/hide per-provider blocks.
          this.display();
        });
      });

    const isAnthropic = this.plugin.settings.provider === 'anthropic';
    const isOpenRouter = this.plugin.settings.provider === 'openrouter';

    // ── Anthropic block ───────────────────────────────────────────
    if (isAnthropic) {
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
    }

    // ── OpenRouter block ──────────────────────────────────────────
    if (isOpenRouter) {
      new Setting(containerEl).setName('OpenRouter').setHeading();

      // Privacy notice. Honest framing — prompts pass through
      // OpenRouter in addition to the underlying provider. Styles in
      // packages/plugin/styles.css (.scribian-privacy-notice).
      const notice = containerEl.createEl('div', {
        cls: 'scribian-privacy-notice',
      });
      notice.createEl('strong', { text: 'Privacy notice. ' });
      notice.createSpan({
        text:
          'When OpenRouter is the active provider, your prompts ' +
          '(including vault content attached as context) pass through ' +
          "OpenRouter's API in addition to the underlying model " +
          "provider you select. See OpenRouter's privacy policy at ",
      });
      const link = notice.createEl('a', {
        text: 'openrouter.ai/privacy',
        href: 'https://openrouter.ai/privacy',
      });
      link.setAttr('target', '_blank');
      notice.createSpan({
        text:
          ', and scribian\'s security model in docs/security-model.md.',
      });

      new Setting(containerEl)
        .setName('API key')
        .setDesc(
          'OpenRouter API key from openrouter.ai. Stored in plugin data, synced across your devices via Obsidian Sync. Leave blank to fall back to the Worker secret OPENROUTER_API_KEY.',
        )
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setPlaceholder('sk-or-…')
            .setValue(this.plugin.settings.openrouterApiKey)
            .onChange(async (v) => {
              this.plugin.settings.openrouterApiKey = v.trim();
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName('Default model')
        .setDesc(
          'OpenRouter model id (namespaced, e.g. anthropic/claude-opus-4-7, openai/gpt-5.2, meta-llama/llama-3.3-70b-instruct). Type to search the catalog.',
        )
        .addText((t) => {
          t.setPlaceholder('anthropic/claude-sonnet-4-6')
            .setValue(this.plugin.settings.openrouterModel);
          t.onChange(async (v) => {
            this.plugin.settings.openrouterModel = v.trim();
            await this.plugin.saveSettings();
          });
          new ModelSuggest(this.app, t.inputEl, async (model) => {
            this.plugin.settings.openrouterModel = model.id;
            await this.plugin.saveSettings();
          });
        });
    }

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

    // ── Memory ────────────────────────────────────────────────────
    new Setting(containerEl).setName('Memory').setHeading();

    new Setting(containerEl)
      .setName('Enable memory note')
      .setDesc(
        "Inject a single vault note's contents into every chat's system prompt as Claude's long-term memory. Claude can read it inline and propose updates via write_note / edit_note (you approve via diff card).",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.memoryEnabled).onChange(async (v) => {
          this.plugin.settings.memoryEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Memory note path')
      .setDesc(
        'Vault-relative path of the memory note. Created on first write if it does not exist. Default: Scribian/Memory.md',
      )
      .addText((t) => {
        t.setPlaceholder('Scribian/Memory.md')
          .setValue(this.plugin.settings.memoryPath)
          .onChange(async (v) => {
            this.plugin.settings.memoryPath = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Reindex vault for semantic search')
      .setDesc(
        'Walk markdown notes (excluding chats/logs/saved folders), embed each via Workers AI, upsert to the Worker\'s Vectorize index. Required before find_related works. Re-run after major vault changes. Cost: ~one cent per 1000 notes.',
      )
      .addButton((b) =>
        b.setButtonText('Reindex').onClick(() => {
          void this.plugin.reindexVault();
        }),
      );

    // ── Personas ─────────────────────────────────────────────────
    new Setting(containerEl).setName('Personas').setHeading();

    this.addFolderSetting(
      'Personas folder',
      'Where persona notes live. Each persona is a markdown note; its body (frontmatter stripped) becomes a system-prompt prefix when active. Default: Scribian/Personas',
      'Scribian/Personas',
      'personasFolder',
    );

    new Setting(containerEl)
      .setName('Active persona')
      .setDesc(
        'Vault-relative path of the active persona note (e.g. "Scribian/Personas/code-reviewer.md"). Empty to disable. The persona\'s body prefixes Claude\'s system prompt on every chat.',
      )
      .addText((t) => {
        t.setPlaceholder('Scribian/Personas/code-reviewer.md')
          .setValue(this.plugin.settings.activePersona)
          .onChange(async (v) => {
            this.plugin.settings.activePersona = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // ── Slash commands ───────────────────────────────────────────
    new Setting(containerEl).setName('Slash commands').setHeading();

    this.addFolderSetting(
      'Commands folder',
      'Where command notes live. Each command is a markdown note; the body is a Mustache template expanded into the chat input when picked. Run via the "Scribian: Run command" command-palette entry. Default: Scribian/Commands',
      'Scribian/Commands',
      'commandsFolder',
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
      | 'logsFolder'
      | 'personasFolder'
      | 'commandsFolder',
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
