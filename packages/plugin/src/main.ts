import { Plugin } from 'obsidian';
import { ScribianView, VIEW_TYPE_SCRIBIAN } from './view';
import { ScribianSettingTab, DEFAULT_SETTINGS, type ScribianSettings } from './settings';
import { Logger } from './logger';

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

    this.addSettingTab(new ScribianSettingTab(this.app, this));
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
