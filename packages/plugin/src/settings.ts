/**
 * Settings tab — progressive-disclosure layout.
 *
 * Always-visible (top, no expander):
 *   1. Connection mode dropdown + mode-appropriate Test button
 *   2. Worker URL / token (when mode=worker — mandatory for that mode)
 *   3. Active provider dropdown
 *   4. API key for the active provider
 *   5. Default model for the active provider
 *   6. Memory toggle
 *
 * Behind a single collapsed "Advanced" expander:
 *   Vault folders, Memory path + reindex (reindex hidden in direct mode),
 *   Personas, Slash commands, Capture section.
 *
 * The SkaldSettings + DEFAULT_SETTINGS surface stays here as the
 * canonical interface every other module imports.
 *
 * MODELS is re-exported from settings/provider.ts (ANTHROPIC_MODELS)
 * under the historical name so existing consumers (view.ts model
 * dropdown) don't need updates.
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type { Provider } from '@skald/protocol';
import type SkaldPlugin from './main';
import { ANTHROPIC_MODELS, renderProviderSection } from './settings/provider';
import { renderConnectionModeSection } from './settings/connection-mode';
import { renderWorkerSection } from './settings/worker';
import { renderVaultSection } from './settings/vault';

import { renderPersonasSection } from './settings/personas';
import { renderCommandsSection } from './settings/commands';
import { renderCaptureSection } from './settings/capture';
import { renderMemoryToggle, renderMemoryAdvanced } from './settings/memory';
import { modeCapabilities } from './mode-capabilities';

/** Connection mode. 'direct' calls Anthropic / OpenRouter from the plugin
 * without a Worker; 'worker' tunnels through the Cloudflare Worker.
 * Fresh installs default to 'direct'. Existing installs with a Worker URL
 * already configured stay on 'worker' so the upgrade is non-disruptive
 * (see migrateConnectionMode in settings/connection-mode.ts). */
export type ConnectionMode = 'direct' | 'worker';

export interface SkaldSettings {
  /** Connection mode — whether to use the Worker or call APIs directly. */
  connectionMode: ConnectionMode;
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
  /**
   * Utility model override for cheap tasks (rerank, future memory upkeep).
   * // empty → per-provider default; set to point the cheap/utility role at any model incl. a local one.
   */
  utilityModel?: string;
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
   *   to Skald/Memory.md.
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
   * capturesFolder: where captured notes land. Default Skald/Captures.
   * capturePromptPath: optional vault-relative path to a custom
   *   prompt-template note. Empty → use the kind-default prompt
   *   baked into the capture module.
   */
  capturesFolder: string;
  capturePromptPath: string;
  /**
   * Capture routing.
   * 'auto-route' runs find_related on the generated capture note and
   * appends to a matching vault note when similarity is high.
   * 'inbox' always creates in capturesFolder (legacy behavior).
   */
  captureMode: 'auto-route' | 'inbox';
  /**
   * Polish sweep: configurable empty-state starter chips.
   * startersPath: vault note holding the list of starter chips.
   *   Empty → use the baked-in DEFAULT_STARTER_CHIPS. Format is a
   *   markdown list with optional `:icon-name:` prefix per line.
   */
  startersPath: string;
  /**
   * Extended thinking ("deep mode"). When true AND the active provider
   * supports extended thinking (providerCapabilities.extendedThinking),
   * the Anthropic request includes thinking: { type: 'enabled',
   * budget_tokens: 8192 }. Off by default — slower and costs more
   * (thinking tokens count against output). Never sent to OpenRouter.
   */
  thinkingEnabled: boolean;
}

/** Re-export for backwards-compatible imports. */
export const MODELS = ANTHROPIC_MODELS;

export const DEFAULT_SETTINGS: SkaldSettings = {
  connectionMode: 'direct',
  workerUrl: '',
  workerToken: '',
  provider: 'anthropic',
  anthropicApiKey: '',
  openrouterApiKey: '',
  defaultModel: 'claude-sonnet-4-6',
  openrouterModel: 'anthropic/claude-sonnet-4-6',
  // empty → per-provider default; set to point the cheap/utility role at any model incl. a local one.
  utilityModel: '',
  harnessFolder: '.claude',
  savedNotesFolder: 'Skald/Saved',
  chatsFolder: 'Skald/Chats',
  logsFolder: '',
  memoryEnabled: true,
  memoryPath: 'Skald/Memory.md',
  personasFolder: 'Skald/Personas',
  activePersona: '',
  commandsFolder: 'Skald/Commands',
  capturesFolder: 'Skald/Captures',
  capturePromptPath: '',
  captureMode: 'auto-route',
  startersPath: 'Skald/Starters.md',
  thinkingEnabled: false,
};

export class SkaldSettingTab extends PluginSettingTab {
  plugin: SkaldPlugin;
  /** Whether the Advanced section is expanded. Instance state only —
   * intentionally not persisted to data.json. Resets on tab re-open. */
  private _advancedExpanded = false;

  constructor(app: App, plugin: SkaldPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const redisplay = () => this.display();

    const caps = modeCapabilities(this.plugin.settings.connectionMode);

    // ── Core settings (always visible) ──────────────────────────────
    renderConnectionModeSection(containerEl, this.plugin, redisplay);
    if (this.plugin.settings.connectionMode === 'worker') {
      renderWorkerSection(containerEl, this.plugin);
    }
    renderProviderSection(containerEl, this.plugin, redisplay);

    // Memory toggle lives in core so the most common toggle is
    // immediately accessible without expanding Advanced.
    renderMemoryToggle(containerEl, this.plugin);

    // ── Advanced expander ────────────────────────────────────────────
    renderAdvancedExpander(containerEl, this._advancedExpanded, (expanded) => {
      this._advancedExpanded = expanded;
      redisplay();
    });

    if (this._advancedExpanded) {
      renderVaultSection(containerEl, this.plugin);
      renderMemoryAdvanced(containerEl, this.plugin, caps.usesWorker);
      renderPersonasSection(containerEl, this.plugin);
      renderCommandsSection(containerEl, this.plugin);
      renderCaptureSection(containerEl, this.plugin);
      // Deep thinking toggle — capability-gated (Anthropic only).
      new Setting(containerEl)
        .setName('Deep thinking mode (slower, costs more)')
        .setDesc(
          'When on, Claude reasons step-by-step before responding (Anthropic only). ' +
          'Thinking tokens count as output — budget is 8 192 tokens per turn.',
        )
        .addToggle((t) => {
          t.setValue(this.plugin.settings.thinkingEnabled).onChange(async (v) => {
            this.plugin.settings.thinkingEnabled = v;
            await this.plugin.saveSettings();
          });
        });
    }
  }
}

/** Render the Advanced toggle heading. Clicking it flips the expanded
 * state and calls onChange so the tab re-renders. Uses a Setting with
 * a toggle component — idiomatic Obsidian progressive disclosure. */
function renderAdvancedExpander(
  containerEl: HTMLElement,
  expanded: boolean,
  onChange: (expanded: boolean) => void,
): void {
  new Setting(containerEl)
    .setName('Advanced')
    .setDesc('Vault folders, memory path, personas, slash commands, capture settings.')
    .setHeading()
    .addToggle((t) => {
      t.setValue(expanded).onChange((v) => onChange(v));
      t.toggleEl.setAttribute('aria-label', expanded ? 'Collapse advanced settings' : 'Expand advanced settings');
    });
}
