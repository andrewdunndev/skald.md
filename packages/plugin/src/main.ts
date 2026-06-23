import { Plugin } from 'obsidian';
import { SkaldView, VIEW_TYPE_SKALD } from './view';
import {
  SkaldSettingTab,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type SkaldSettings,
} from './settings';
import { Logger } from './logger';
import { ConversationSearchModal } from './conversation-search';
import { CaptureService } from './capture';
import { utilityModel } from './provider-capabilities';
import {
  loadSlashCommands,
  renderCommand,
  SlashCommandModal,
} from './slash-commands';

export default class SkaldPlugin extends Plugin {
  settings: SkaldSettings = DEFAULT_SETTINGS;
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
      anthropicApiKey: this.settings.anthropicApiKey,
      openrouterApiKey: this.settings.openrouterApiKey,
      defaultModel: this.settings.defaultModel,
      openrouterModel: this.settings.openrouterModel,
      openaiApiKey: this.settings.openaiApiKey,
      openaiModel: this.settings.openaiModel,
      openaiBaseUrl: this.settings.openaiBaseUrl,
      utilityModel: utilityModel(this.settings),
      captureFolder: this.settings.capturesFolder,
      promptPath: this.settings.capturePromptPath,
    }));

    this.registerView(VIEW_TYPE_SKALD, (leaf) => new SkaldView(leaf, this));

    this.addRibbonIcon('message-square', 'Open Skald', () => this.activateView());

    // Phase 8: iOS share-sheet capture via Apple Shortcuts. Each
    // discrete sub-action is its own handler — implicit allowlist
    // through the set of names registered here. No "catch-all"
    // handler that dispatches on action params, so a malformed /
    // attacker-crafted URI like obsidian://skald/delete just
    // 404s instead of reaching a handler that has to decide what
    // to do with it.
    this.registerObsidianProtocolHandler('skald-capture', (data) => {
      this.logger.info(`protocol: skald-capture kind=${data.kind ?? 'text'}`);
      void this.captureService.handleProtocol(data);
    });

    this.addCommand({
      id: 'skald-open',
      name: 'Open chat',
      callback: () => this.activateView(),
    });

    // Phase 10b: fuzzy-search across saved conversations with
    // recency-weighted ranking. Opens the matched file directly;
    // resume-into-pane is a follow-up.
    this.addCommand({
      id: 'skald-search-conversations',
      name: 'Search conversations',
      callback: () => {
        new ConversationSearchModal(this.app, this.settings.chatsFolder).open();
      },
    });

    // Phase 9a: slash commands. Each user-authored command note is
    // a Mustache-style template; on pick, the rendered template
    // drops into the active chat input for review + send.
    this.addCommand({
      id: 'skald-run-command',
      name: 'Run command (slash command)',
      callback: () => void this.runSlashCommand(),
    });

    this.addSettingTab(new SkaldSettingTab(this.app, this));
  }

  async loadSettings() {
    // data.json is a trust boundary: operator-editable AND Obsidian-Sync
    // delivered. normalizeSettings merges DEFAULT_SETTINGS for missing keys,
    // coerces an unknown `provider` back to the default (so it can never reach
    // the exhaustive provider switches), drops non-string/boolean fields, and
    // CLAMPS a cleartext non-loopback openaiBaseUrl to empty so the
    // utility/capture/memory paths can't dispatch prompts + key over the wire.
    const stored: unknown = await this.loadData();
    this.settings = normalizeSettings(stored);
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SKALD)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_SKALD, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
