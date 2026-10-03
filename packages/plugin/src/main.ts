import { Notice, Plugin, type ObsidianProtocolData } from 'obsidian';
import { revealChatLeaf } from './reveal-chat-leaf';
import { SkaldView, VIEW_TYPE_SKALD } from './view';
import {
  SkaldSettingTab,
  DEFAULT_SETTINGS,
  type SkaldSettings,
} from './settings';
import { normalizeSettings } from './settings-normalize';
import { resolveApiKeys, type ApiKeys } from './api-keys';
import { Logger } from './logger';
import { CAPTURE_OFF_NOTICE, CaptureService } from './capture';
import { utilityModel } from './provider-capabilities';
import {
  loadSlashCommands,
  renderCommand,
  SlashCommandModal,
} from './slash-commands';

export default class SkaldPlugin extends Plugin {
  override settings: SkaldSettings = DEFAULT_SETTINGS;
  logger!: Logger;
  private captureService!: CaptureService;
  /**
   * Cumulative estimated cost (USD) across every chat in this app
   * session, including chats cleared via New Chat. In-memory only —
   * never persisted to disk; resets to 0 on plugin reload. Surfaced
   * in the cost footer to build user confidence ("session: $0.21").
   */
  sessionCostUSD = 0;

  override async onload() {
    await this.loadSettings();
    this.logger = new Logger(this.app, () => this.settings.logsFolder);
    this.logger.info('skald loaded');

    this.captureService = new CaptureService(this.app, () => ({
      provider: this.settings.provider,
      ...this.apiKeys(),
      defaultModel: this.settings.defaultModel,
      openrouterModel: this.settings.openrouterModel,
      openaiModel: this.settings.openaiModel,
      openaiBaseUrl: this.settings.openaiBaseUrl,
      utilityModel: utilityModel(this.settings),
      captureFolder: this.settings.capturesFolder,
      promptPath: this.settings.capturePromptPath,
    }));

    this.registerView(VIEW_TYPE_SKALD, (leaf) => new SkaldView(leaf, this));

    this.addRibbonIcon('message-square', 'Open Skald', () => this.activateView());

    // Share-sheet capture via an Apple Shortcut. One named handler, no
    // catch-all that dispatches on params, so an unknown
    // obsidian://skald-* action reaches nothing.
    this.registerObsidianProtocolHandler('skald-capture', (data) =>
      this.onCaptureLink(data),
    );

    this.addCommand({
      id: 'open',
      name: 'Open chat',
      callback: () => this.activateView(),
    });

    // Fuzzy-search across saved conversations with recency-weighted
    // ranking. Opens the matched file directly.
    this.addCommand({
      id: 'search-conversations',
      name: 'Search conversations',
      callback: () => {
        void (async () => {
          await this.activateView();
          this.findChatView()?.openHistoryModal();
        })();
      },
    });

    // Slash commands. Each user-authored command note is
    // a Mustache-style template; on pick, the rendered template
    // drops into the active chat input for review + send.
    this.addCommand({
      id: 'run-slash',
      name: 'Run slash command',
      callback: () => void this.runSlashCommand(),
    });

    this.addSettingTab(new SkaldSettingTab(this.app, this));
  }

  async loadSettings() {
    // data.json is a trust boundary: operator-editable AND Obsidian-Sync
    // delivered. normalizeSettings merges DEFAULT_SETTINGS for missing keys,
    // drops unknown fields, coerces an unknown `provider` back to the default
    // (so it can never reach the exhaustive provider switches), drops
    // non-string/boolean fields, and CLAMPS a cleartext non-loopback
    // openaiBaseUrl to empty so the utility/capture/memory paths can't
    // dispatch prompts + key over the wire.
    const stored: unknown = await this.loadData();
    this.settings = normalizeSettings(stored);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Any app or page can open the capture link, so it does nothing
   * until the user turns capture on. */
  private onCaptureLink(data: ObsidianProtocolData): void {
    if (!this.settings.captureEnabled) {
      new Notice(CAPTURE_OFF_NOTICE, 10_000);
      return;
    }
    this.logger.info('protocol: skald-capture');
    void this.captureService.handleProtocol(data);
  }

  /** The API keys for this request, read from secret storage by the secret
   * names in settings. Settings never carry a key value. */
  apiKeys(): ApiKeys {
    return resolveApiKeys(this.app.secretStorage, this.settings);
  }

  /**
   * Load every command note from the configured folder, present a
   * picker modal, and drop the rendered template into the active
   * chat view's input on pick. The user reviews + sends in the
   * regular chat flow.
   *
   * Activates the chat pane first so there's always somewhere for
   * the template to land — invoking from anywhere in the workspace
   * shouldn't fail silently.
   */
  private async runSlashCommand(): Promise<void> {
    const commands = await loadSlashCommands(
      this.app,
      this.settings.commandsFolder,
    );
    new SlashCommandModal(this.app, commands, (cmd) => {
      void (async () => {
        const rendered = await renderCommand(this.app, cmd);
        await this.activateView();
        const view = this.findChatView();
        if (view) view.fillInput(rendered);
      })();
    }).open();
  }

  private findChatView(): SkaldView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SKALD);
    const view = leaves[0]?.view;
    return view instanceof SkaldView ? view : null;
  }

  async activateView() {
    await revealChatLeaf(this.app.workspace, VIEW_TYPE_SKALD);
  }
}
