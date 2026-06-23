/**
 * Settings tab — progressive-disclosure layout.
 *
 * Always-visible (top, no expander):
 *   1. Active provider dropdown
 *   2. API key for the active provider
 *   3. Default model for the active provider
 *   4. Memory toggle
 *
 * Behind a single collapsed "Advanced" expander:
 *   Vault folders, Memory path, Personas, Slash commands, Capture section.
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
import { isProvider } from './provider-capabilities';
import { validateOpenAiBaseUrl } from './openai-base-url';
import { ANTHROPIC_MODELS, renderProviderSection } from './settings/provider';
import { renderVaultSection } from './settings/vault';

import { renderPersonasSection } from './settings/personas';
import { renderCommandsSection } from './settings/commands';
import { renderCaptureSection } from './settings/capture';
import { renderMemoryToggle, renderMemoryAdvanced } from './settings/memory';

export interface SkaldSettings {
  /**
   * Active provider. Anthropic-direct is the default (rich content
   * blocks, native server tools, prompt caching). OpenRouter is the
   * opt-in fallback for non-Anthropic models via the namespaced
   * catalog.
   */
  provider: Provider;
  anthropicApiKey: string;
  openrouterApiKey: string;
  /** API key (Bearer token) for an OpenAI-compatible endpoint
   * (used when provider=openai). */
  openaiApiKey: string;
  /** Base URL for an OpenAI-compatible endpoint, e.g.
   * https://llm.dunn.dev/v1 (used when provider=openai). */
  openaiBaseUrl: string;
  /** Free-text model id for the OpenAI-compatible endpoint, e.g.
   * qwen2.5-14b (used when provider=openai). */
  openaiModel: string;
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
  /**
   * Compact large tool results before they enter the model context.
   * Uniform JSON arrays are encoded as TOON (compact tabular notation);
   * other JSON is minified; plain text has repeated lines collapsed.
   * The byte cap (capResult) remains the hard backstop. Default: true.
   * Disable if a downstream model misreads TOON output.
   */
  compactToolResults: boolean;
}

/** Re-export for backwards-compatible imports. */
export const MODELS = ANTHROPIC_MODELS;

export const DEFAULT_SETTINGS: SkaldSettings = {
  provider: 'anthropic',
  anthropicApiKey: '',
  openrouterApiKey: '',
  openaiApiKey: '',
  openaiBaseUrl: '',
  openaiModel: '',
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
  startersPath: 'Skald/Starters.md',
  thinkingEnabled: false,
  compactToolResults: true,
};

/**
 * Normalize a settings object loaded from disk into a fully-valid
 * SkaldSettings, treating the input as UNTRUSTED.
 *
 * data.json is operator-editable AND delivered by Obsidian Sync, so the
 * persisted blob is a trust boundary: a hand-edited or sync-corrupted file
 * can carry an unknown `provider` (which would otherwise reach the exhaustive
 * `switch (provider)` sites and throw via assertNever), non-string fields
 * (which would break downstream `.trim()`/string ops), missing keys, or a
 * cleartext non-loopback OpenAI base URL (which would leak prompts + the API
 * key over the wire, bypassing the https-enforcement that only runs on the
 * settings-UI save path).
 *
 * Normalization rules:
 *   - Start from DEFAULT_SETTINGS, then overlay only recognised keys.
 *   - `provider`: coerce any non-Provider value to the default ('anthropic').
 *   - string fields: keep only when the stored value is a string; otherwise
 *     fall back to the default.
 *   - boolean fields: keep only real booleans; otherwise default.
 *   - `openaiBaseUrl`: run validateOpenAiBaseUrl and CLAMP — if the persisted
 *     URL is insecure (cleartext non-loopback, bad scheme, unparseable),
 *     blank it so the utility/capture paths cannot dispatch over it.
 *
 * Valid settings round-trip unchanged.
 */
export function normalizeSettings(stored: unknown): SkaldSettings {
  const raw: Record<string, unknown> =
    stored !== null && typeof stored === 'object'
      ? (stored as Record<string, unknown>)
      : {};

  const out: SkaldSettings = { ...DEFAULT_SETTINGS };

  // Pull a string field only when the stored value is actually a string;
  // anything else (number, object, null, missing) falls back to the default.
  const str = (key: keyof SkaldSettings): string => {
    const v = raw[key as string];
    return typeof v === 'string' ? v : (DEFAULT_SETTINGS[key] as string);
  };
  // Pull a boolean field only when the stored value is a real boolean.
  const bool = (key: keyof SkaldSettings): boolean => {
    const v = raw[key as string];
    return typeof v === 'boolean' ? v : (DEFAULT_SETTINGS[key] as boolean);
  };

  // provider — coerce unknown values back to the safe default so they can
  // never reach the exhaustive provider switches.
  out.provider = isProvider(raw.provider)
    ? raw.provider
    : DEFAULT_SETTINGS.provider;

  // String-typed settings.
  out.anthropicApiKey = str('anthropicApiKey');
  out.openrouterApiKey = str('openrouterApiKey');
  out.openaiApiKey = str('openaiApiKey');
  out.openaiModel = str('openaiModel');
  out.defaultModel = str('defaultModel');
  out.openrouterModel = str('openrouterModel');
  out.harnessFolder = str('harnessFolder');
  out.savedNotesFolder = str('savedNotesFolder');
  out.chatsFolder = str('chatsFolder');
  out.logsFolder = str('logsFolder');
  out.memoryPath = str('memoryPath');
  out.personasFolder = str('personasFolder');
  out.activePersona = str('activePersona');
  out.commandsFolder = str('commandsFolder');
  out.capturesFolder = str('capturesFolder');
  out.capturePromptPath = str('capturePromptPath');
  out.startersPath = str('startersPath');

  // utilityModel is optional (string | undefined). Keep a stored string,
  // otherwise leave it as the default (empty string).
  out.utilityModel =
    typeof raw.utilityModel === 'string'
      ? raw.utilityModel
      : DEFAULT_SETTINGS.utilityModel;

  // Boolean-typed settings.
  out.memoryEnabled = bool('memoryEnabled');
  out.thinkingEnabled = bool('thinkingEnabled');
  out.compactToolResults = bool('compactToolResults');

  // openaiBaseUrl — CLAMP against the https-enforcement rule. A hand-edited
  // cleartext (non-loopback) URL would otherwise be used verbatim by the
  // utility/capture/memory-upkeep paths, leaking prompts + key over the wire.
  // Keep only a string that passes validateOpenAiBaseUrl; blank anything else.
  const candidateBaseUrl =
    typeof raw.openaiBaseUrl === 'string' ? raw.openaiBaseUrl : '';
  out.openaiBaseUrl = validateOpenAiBaseUrl(candidateBaseUrl).ok
    ? candidateBaseUrl
    : '';

  return out;
}

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

    // ── Core settings (always visible) ──────────────────────────────
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
      renderMemoryAdvanced(containerEl, this.plugin);
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

      // Tool-result compaction toggle.
      new Setting(containerEl)
        .setName('Compact tool results (reduces token usage)')
        .setDesc(
          'Shrinks large tool outputs before they enter the model context: uniform JSON arrays ' +
          'become compact TOON tables; other JSON is minified; repeated text lines are collapsed. ' +
          'Disable if your model misreads compact output.',
        )
        .addToggle((t) => {
          t.setValue(this.plugin.settings.compactToolResults).onChange(async (v) => {
            this.plugin.settings.compactToolResults = v;
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
