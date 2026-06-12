import { Notice, Plugin } from 'obsidian';
import { ScribianView, VIEW_TYPE_SCRIBIAN } from './view';
import { ScribianSettingTab, DEFAULT_SETTINGS, type ScribianSettings } from './settings';
import { migrateConnectionMode } from './settings/connection-mode';
import { resolveConnectionMode } from './mode-capabilities';
import { Logger } from './logger';
import { reindexVault } from './memory-client';
import { emptyManifest, type IndexManifest } from './index-manifest';
import { ConversationSearchModal } from './conversation-search';
import { CaptureService } from './capture';
import { parseSetupParams } from './setup-uri';
import { SetupConfirmModal } from './setup-confirm-modal';
import {
  loadSlashCommands,
  renderCommand,
  SlashCommandModal,
} from './slash-commands';

export default class ScribianPlugin extends Plugin {
  settings: ScribianSettings = DEFAULT_SETTINGS;
  /**
   * The raw connectionMode string as stored in data.json. Kept separately
   * so that a future mode value stored by a newer version of scribian is
   * preserved on save rather than clobbered by downgrade to 'direct'.
   * Runtime code always reads this.settings.connectionMode (a valid
   * ConnectionMode resolved by resolveConnectionMode).
   */
  private _rawConnectionMode: string = DEFAULT_SETTINGS.connectionMode;
  logger!: Logger;
  private captureService!: CaptureService;

  override async onload() {
    await this.loadSettings();
    this.logger = new Logger(this.app, () => this.settings.logsFolder);
    this.logger.info('scribian loaded');

    this.captureService = new CaptureService(this.app, () => ({
      connectionMode: this.settings.connectionMode,
      workerUrl: this.settings.workerUrl,
      workerToken: this.settings.workerToken,
      provider: this.settings.provider,
      anthropicApiKey: this.settings.anthropicApiKey,
      openrouterApiKey: this.settings.openrouterApiKey,
      defaultModel: this.settings.defaultModel,
      openrouterModel: this.settings.openrouterModel,
      captureFolder: this.settings.capturesFolder,
      promptPath: this.settings.capturePromptPath,
      mode: this.settings.captureMode,
    }));

    this.registerView(VIEW_TYPE_SCRIBIAN, (leaf) => new ScribianView(leaf, this));

    this.addRibbonIcon('message-square', 'Open Scribian', () => this.activateView());

    // Phase 8: iOS share-sheet capture via Apple Shortcuts. Each
    // discrete sub-action is its own handler — implicit allowlist
    // through the set of names registered here. No "catch-all"
    // handler that dispatches on action params, so a malformed /
    // attacker-crafted URI like obsidian://scribian/delete just
    // 404s instead of reaching a handler that has to decide what
    // to do with it.
    this.registerObsidianProtocolHandler('scribian-capture', (data) => {
      this.logger.info(`protocol: scribian-capture kind=${data.kind ?? 'text'}`);
      void this.captureService.handleProtocol(data);
    });

    // Setup URI: second-device onboarding without retyping the
    // Worker URL + token on a phone keyboard. The host machine
    // (where the Worker was deployed) generates the URI; the iPad
    // opens it and the plugin populates settings. The token is
    // bearer-grade — sharing this URI is sharing the token.
    this.registerObsidianProtocolHandler('scribian-setup', (data) => {
      void this.handleSetupUri(data);
    });

    this.addCommand({
      id: 'scribian-open',
      name: 'Open chat',
      callback: () => this.activateView(),
    });

    // Phase 6: vault-as-memory. The Reindex command walks vault notes
    // and ships them to the Worker's /index endpoint for embedding +
    // upsert into Vectorize. find_related queries depend on this
    // having run at least once.
    this.addCommand({
      id: 'scribian-reindex-vault',
      name: 'Reindex vault (for semantic search)',
      callback: () => {
        void this.reindexVault();
      },
    });

    // Phase 10b: fuzzy-search across saved conversations with
    // recency-weighted ranking. Opens the matched file directly;
    // resume-into-pane is a follow-up.
    this.addCommand({
      id: 'scribian-search-conversations',
      name: 'Search conversations',
      callback: () => {
        new ConversationSearchModal(this.app, this.settings.chatsFolder).open();
      },
    });

    // Phase 9a: slash commands. Each user-authored command note is
    // a Mustache-style template; on pick, the rendered template
    // drops into the active chat input for review + send.
    this.addCommand({
      id: 'scribian-run-command',
      name: 'Run command (slash command)',
      callback: () => void this.runSlashCommand(),
    });

    this.addSettingTab(new ScribianSettingTab(this.app, this));
  }

  /**
   * Run an incremental reindex of the vault for semantic search.
   * The plugin maintains a {path → {mtime, size}} manifest in
   * plugin data; only added/modified/deleted entries hit the
   * Worker. Excludes the conversation, logs, and saved-notes
   * folders since they're scribian-generated artifacts the user
   * doesn't want surfaced as "related notes."
   *
   * Public so the settings tab can invoke it directly without
   * going through the command bus.
   */
  async reindexVault(): Promise<void> {
    const cfg = {
      workerUrl: this.settings.workerUrl,
      workerToken: this.settings.workerToken,
    };
    if (!cfg.workerUrl || !cfg.workerToken) {
      new Notice('scribian: Worker URL + token must be configured first.');
      return;
    }
    const excluded = [
      this.settings.chatsFolder,
      this.settings.logsFolder,
      this.settings.savedNotesFolder,
    ].filter(Boolean);
    const progressNotice = new Notice('Reindexing vault…', 0);
    try {
      const result = await reindexVault(
        this.app,
        cfg,
        excluded,
        (msg) => progressNotice.setMessage(`scribian: ${msg}`),
        () => this.loadIndexManifest(),
        (m) => this.saveIndexManifest(m),
      );
      progressNotice.hide();
      new Notice(
        `scribian: reindex complete — +${result.added} new, ~${result.modified} changed, −${result.deleted} removed (skipped ${result.skipped}).`,
        7000,
      );
      this.logger.info(
        `reindex complete: added=${result.added} modified=${result.modified} deleted=${result.deleted} unchanged=${result.skipped}`,
      );
    } catch (err) {
      progressNotice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`scribian: reindex failed — ${msg}`, 8000);
      this.logger.error(`reindex failed: ${msg}`);
    }
  }

  /**
   * The index manifest is stored next to `data.json` as
   * `index-manifest.json` in the plugin's storage folder. Kept
   * separate so it doesn't bloat `data.json` (which is read on
   * every plugin load).
   */
  private manifestPath(): string {
    return `${this.manifest.dir}/index-manifest.json`;
  }

  private async loadIndexManifest(): Promise<IndexManifest> {
    try {
      const raw = await this.app.vault.adapter.read(this.manifestPath());
      const parsed = JSON.parse(raw) as IndexManifest;
      if (parsed?.version === 1 && parsed.entries) return parsed;
    } catch {
      // missing or unreadable — start fresh
    }
    return emptyManifest();
  }

  private async saveIndexManifest(m: IndexManifest): Promise<void> {
    await this.app.vault.adapter.write(
      this.manifestPath(),
      JSON.stringify(m, null, 2),
    );
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<Record<string, unknown>> | null;
    const base = stored ?? {};
    // Step 1: migrate — detect Worker-era installs without connectionMode.
    // migrateConnectionMode returns a valid ConnectionMode or the existing
    // recognized value; it doesn't handle unrecognized future values.
    const migrated = migrateConnectionMode(base);
    // Step 2: resolve — if migration returned a recognized value, use it.
    // If the raw stored value is an unrecognized future mode, preserve it
    // in _rawConnectionMode for round-trip fidelity and fall back to
    // 'direct' for runtime behavior.
    const rawStored = base.connectionMode;
    this._rawConnectionMode =
      typeof rawStored === 'string' && rawStored ? rawStored : migrated;
    const connectionMode = resolveConnectionMode(this._rawConnectionMode);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(base as Partial<ScribianSettings>),
      connectionMode,
    };
  }

  async saveSettings() {
    // Preserve the raw connectionMode string so a future mode value stored
    // by a newer version of scribian is not clobbered on downgrade.
    // If the current runtime mode differs from the raw stored value (user
    // changed mode in settings), the new mode becomes the canonical value.
    const rawMode =
      this.settings.connectionMode !== resolveConnectionMode(this._rawConnectionMode)
        ? this.settings.connectionMode
        : this._rawConnectionMode;
    await this.saveData({ ...this.settings, connectionMode: rawMode });
    this._rawConnectionMode = rawMode;
  }

  /**
   * Handle obsidian://scribian-setup. Validates the URI's endpoint +
   * token via the pure parser, then surfaces a confirmation modal
   * before writing both fields to settings. The setup URI is
   * bearer-grade — a silent rewrite would turn a forwarded link
   * into a phishing vector, so the user must explicitly accept
   * the endpoint + masked token preview.
   */
  private async handleSetupUri(data: Record<string, string>): Promise<void> {
    const result = parseSetupParams(data);
    if (!result.ok) {
      this.logger.warn(`scribian-setup rejected: ${result.reason}`);
      new Notice(`scribian: setup link invalid — ${result.reason}`, 8000);
      return;
    }
    const { endpoint, token } = result.params;
    this.logger.info(`scribian-setup preview shown: endpoint=${endpoint}`);
    new SetupConfirmModal(
      this.app,
      {
        endpoint,
        token,
        currentEndpoint: this.settings.workerUrl,
      },
      {
        onConfirm: async () => {
          this.settings.workerUrl = endpoint;
          this.settings.workerToken = token;
          await this.saveSettings();
          this.logger.info(`scribian-setup applied: endpoint=${endpoint}`);
          new Notice(
            `scribian: configured against ${endpoint}. Don't share that link — it contains your Worker token. Open the chat pane to verify the connection.`,
            10000,
          );
        },
        onCancel: () => {
          this.logger.info('scribian-setup cancelled by user');
        },
      },
    ).open();
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

  private findChatView(): ScribianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCRIBIAN);
    const view = leaves[0]?.view;
    return view instanceof ScribianView ? view : null;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SCRIBIAN)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      leaf = right;
      await leaf.setViewState({ type: VIEW_TYPE_SCRIBIAN, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
