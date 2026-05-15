import { Notice, Plugin } from 'obsidian';
import { ScribianView, VIEW_TYPE_SCRIBIAN } from './view';
import { ScribianSettingTab, DEFAULT_SETTINGS, type ScribianSettings } from './settings';
import { Logger } from './logger';
import { reindexVault } from './memory-client';
import { ConversationSearchModal } from './conversation-search';

export default class ScribianPlugin extends Plugin {
  settings: ScribianSettings = DEFAULT_SETTINGS;
  logger!: Logger;

  override async onload() {
    await this.loadSettings();
    this.logger = new Logger(this.app, () => this.settings.logsFolder);
    this.logger.info('scribian loaded');

    this.registerView(VIEW_TYPE_SCRIBIAN, (leaf) => new ScribianView(leaf, this));

    this.addRibbonIcon('message-square', 'Open Scribian', () => this.activateView());

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

    this.addSettingTab(new ScribianSettingTab(this.app, this));
  }

  /**
   * Run a full reindex of the vault for semantic search. Surface
   * progress as Notices. Excludes the conversation, logs, and
   * saved-notes folders by default since they're scribian-generated
   * artifacts the user doesn't want surfaced as "related notes."
   *
   * Public so the settings tab can invoke it directly without going
   * through the command bus.
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
      );
      progressNotice.hide();
      new Notice(
        `scribian: reindexed ${result.indexed} note${
          result.indexed === 1 ? '' : 's'
        } (skipped ${result.skipped}).`,
        6000,
      );
      this.logger.info(
        `reindex complete: indexed=${result.indexed} skipped=${result.skipped}`,
      );
    } catch (err) {
      progressNotice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`scribian: reindex failed — ${msg}`, 8000);
      this.logger.error(`reindex failed: ${msg}`);
    }
  }

  async loadSettings() {
    const stored = (await this.loadData()) as Partial<ScribianSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
