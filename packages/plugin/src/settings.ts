/**
 * Settings tab — the small dispatcher shell. Each section's render
 * function lives in `settings/<section>.ts` so individual sections
 * stay focused + the dispatcher stays under the LOC cap.
 *
 * The ScribianSettings + DEFAULT_SETTINGS surface stays here as the
 * canonical interface every other module imports.
 *
 * MODELS is re-exported from settings/provider.ts (ANTHROPIC_MODELS)
 * under the historical name so existing consumers (view.ts model
 * dropdown) don't need updates.
 */

import { App, PluginSettingTab } from 'obsidian';
import type { Provider } from '@scribian/protocol';
import type ScribianPlugin from './main';
import { ANTHROPIC_MODELS, renderProviderSection } from './settings/provider';
import { renderWorkerSection } from './settings/worker';
import { renderVaultSection } from './settings/vault';
import { renderMemorySection } from './settings/memory';
import { renderPersonasSection } from './settings/personas';
import { renderCommandsSection } from './settings/commands';
import { renderCaptureSection } from './settings/capture';

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
   * personasFolder: where the user keeps persona notes.
   * activePersona: vault-relative path of the active persona note.
   *   Empty → no persona. The note's body (frontmatter stripped)
   *   prefixes the system prompt.
   */
  personasFolder: string;
  activePersona: string;
  /**
   * Phase 9a: slash commands.
   * commandsFolder: where the user keeps slash-command notes.
   */
  commandsFolder: string;
  /**
   * Phase 8: iOS share-sheet capture.
   * capturesFolder: where captured notes land. Default Scribian/Captures.
   * capturePromptPath: optional vault-relative path to a custom
   *   prompt-template note. Empty → use the kind-default prompt
   *   baked into the capture module.
   */
  capturesFolder: string;
  capturePromptPath: string;
}

/** Re-export for backwards-compatible imports. */
export const MODELS = ANTHROPIC_MODELS;

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
  capturesFolder: 'Scribian/Captures',
  capturePromptPath: '',
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
    const redisplay = () => this.display();

    renderWorkerSection(containerEl, this.plugin);
    renderProviderSection(containerEl, this.plugin, redisplay);
    renderVaultSection(containerEl, this.plugin);
    renderMemorySection(containerEl, this.plugin);
    renderPersonasSection(containerEl, this.plugin);
    renderCommandsSection(containerEl, this.plugin);
    renderCaptureSection(containerEl, this.plugin);
  }
}
