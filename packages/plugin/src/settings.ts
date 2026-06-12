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
 * The ScribianSettings + DEFAULT_SETTINGS surface stays here as the
 * canonical interface every other module imports.
 *
 * MODELS is re-exported from settings/provider.ts (ANTHROPIC_MODELS)
 * under the historical name so existing consumers (view.ts model
 * dropdown) don't need updates.
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type { Provider } from '@scribian/protocol';
import type ScribianPlugin from './main';
import { ANTHROPIC_MODELS, renderProviderSection } from './settings/provider';
import { renderConnectionModeSection } from './settings/connection-mode';
import { renderWorkerSection } from './settings/worker';
import { renderVaultSection } from './settings/vault';

import { renderPersonasSection } from './settings/personas';
import { renderCommandsSection } from './settings/commands';
import { renderCaptureSection } from './settings/capture';
import { modeCapabilities } from './mode-capabilities';

/** Connection mode. 'direct' calls Anthropic / OpenRouter from the plugin
 * without a Worker; 'worker' tunnels through the Cloudflare Worker.
 * Fresh installs default to 'direct'. Existing installs with a Worker URL
 * already configured stay on 'worker' so the upgrade is non-disruptive
 * (see migrateConnectionMode in settings/connection-mode.ts). */
export type ConnectionMode = 'direct' | 'worker';

export interface ScribianSettings {
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
}

/** Re-export for backwards-compatible imports. */
export const MODELS = ANTHROPIC_MODELS;

export const DEFAULT_SETTINGS: ScribianSettings = {
  connectionMode: 'direct',
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
  captureMode: 'auto-route',
  startersPath: 'Scribian/Starters.md',
};

export class ScribianSettingTab extends PluginSettingTab {
  plugin: ScribianPlugin;
  /** Whether the Advanced section is expanded. Instance state only —
   * intentionally not persisted to data.json. Resets on tab re-open. */
  private _advancedExpanded = false;

  constructor(app: App, plugin: ScribianPlugin) {
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
    renderMemoryToggleOnly(containerEl, this.plugin);

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
    }
  }
}

/** Render just the memory toggle (always-visible core item). */
function renderMemoryToggleOnly(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
): void {
  new Setting(containerEl)
    .setName('Enable memory note')
    .setDesc(
      "Inject a single vault note's contents into every chat's system prompt as Claude's long-term memory. Claude can read it inline and propose updates via write_note / edit_note (you approve via diff card).",
    )
    .addToggle((t) =>
      t.setValue(plugin.settings.memoryEnabled).onChange(async (v) => {
        plugin.settings.memoryEnabled = v;
        await plugin.saveSettings();
      }),
    );
}

/** Render only the advanced memory items (path + reindex) for the
 * Advanced section. Delegates reindex gating to renderMemorySection. */
function renderMemoryAdvanced(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
  usesWorker: boolean,
): void {
  // renderMemorySection renders heading + toggle + path + reindex.
  // We skip the toggle here (it lives in core) by rendering a
  // dedicated sub-section with just the path and reindex items.
  new Setting(containerEl).setName('Memory').setHeading();

  new Setting(containerEl)
    .setName('Memory note path')
    .setDesc(
      'Vault-relative path of the memory note. Created on first write if it does not exist. Default: Scribian/Memory.md',
    )
    .addText((t) => {
      t.setPlaceholder('Scribian/Memory.md')
        .setValue(plugin.settings.memoryPath)
        .onChange(async (v) => {
          plugin.settings.memoryPath = v.trim();
          await plugin.saveSettings();
        });
    });

  if (usesWorker) {
    new Setting(containerEl)
      .setName('Reindex vault for semantic search')
      .setDesc(
        "Walk markdown notes (excluding chats/logs/saved folders), embed each via Workers AI, upsert to the Worker's Vectorize index. Required before find_related works. Re-run after major vault changes. Cost: ~one cent per 1000 notes.",
      )
      .addButton((b) =>
        b.setButtonText('Reindex').onClick(() => {
          void plugin.reindexVault();
        }),
      );
  } else {
    new Setting(containerEl)
      .setName('Reindex vault for semantic search')
      .setDesc(
        "Requires Worker mode — semantic search uses the Worker's Vectorize binding which is unavailable in direct mode. Switch to Worker mode to enable reindexing.",
      )
      .addButton((b) => b.setButtonText('Reindex').setDisabled(true));
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
    .setDesc(
      expanded
        ? 'Vault folders, memory path, personas, slash commands, capture settings.'
        : 'Vault folders, memory path, personas, slash commands, capture settings.',
    )
    .setHeading()
    .addToggle((t) => {
      t.setValue(expanded).onChange((v) => onChange(v));
      t.toggleEl.setAttribute('aria-label', expanded ? 'Collapse advanced settings' : 'Expand advanced settings');
    });
}
