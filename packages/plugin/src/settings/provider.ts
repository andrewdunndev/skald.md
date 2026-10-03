/**
 * Provider section: Anthropic vs OpenRouter selection + per-provider
 * blocks (API key, default model). The per-provider blocks render
 * conditionally on the active provider — switching causes the
 * settings tab to re-render so the visible block always matches.
 *
 * Privacy notice for OpenRouter lives inline here because it's
 * physically next to the toggle that activates the affected path.
 * Styles in plugin/styles.css (.skald-privacy-notice).
 */

import { Notice, Setting } from 'obsidian';
import type { Provider } from '@skald/protocol';
import type SkaldPlugin from '../main';
import { ModelSuggest } from '../model-suggest';
import { validateOpenAiBaseUrl } from '../openai-base-url';

export const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
] as const;

export function renderProviderSection(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
  redisplay: () => void,
): void {
  new Setting(containerEl).setName('Provider').setHeading();

  new Setting(containerEl)
    .setName('Active provider')
    .setDesc(
      'Anthropic (direct): rich content blocks, native server tools, prompt caching. OpenRouter: fallback for non-Anthropic models via OpenRouter\'s Anthropic-compatible endpoint.',
    )
    .addDropdown((d) => {
      d.addOption('anthropic', 'Anthropic (direct)');
      d.addOption('openrouter', 'OpenRouter (fallback)');
      d.addOption('openai', 'OpenAI-compatible');
      d.setValue(plugin.settings.provider).onChange(async (v) => {
        plugin.settings.provider = v as Provider;
        await plugin.saveSettings();
        // Re-render so the per-provider block flips.
        redisplay();
      });
    });

  if (plugin.settings.provider === 'anthropic') {
    renderAnthropicBlock(containerEl, plugin);
  } else if (plugin.settings.provider === 'openai') {
    renderOpenaiBlock(containerEl, plugin);
  } else {
    renderOpenRouterBlock(containerEl, plugin);
  }
}

function renderAnthropicBlock(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('Anthropic').setHeading();

  new Setting(containerEl)
    .setName('API key')
    .setDesc(
      'sk-ant-… key from console.anthropic.com. Required — Skald sends requests directly to Anthropic using this key. Stored in plugin data, synced across your devices via Obsidian Sync.',
    )
    .addText((t) => {
      t.inputEl.type = 'password';
      t.setPlaceholder('sk-ant-…')
        .setValue(plugin.settings.anthropicApiKey)
        .onChange(async (v) => {
          plugin.settings.anthropicApiKey = v.trim();
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName('Default model')
    .setDesc(
      'Anthropic model used for new chats. Pickable per-chat in the chat header.',
    )
    .addDropdown((d) => {
      for (const m of ANTHROPIC_MODELS) d.addOption(m.id, m.label);
      d.setValue(plugin.settings.defaultModel).onChange(async (v) => {
        plugin.settings.defaultModel = v;
        await plugin.saveSettings();
      });
    });
}

function renderOpenRouterBlock(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('OpenRouter').setHeading();

  const notice = containerEl.createEl('div', {
    cls: 'skald-privacy-notice',
  });
  notice.createEl('strong', { text: 'Privacy notice. ' });
  notice.createSpan({
    text:
      'When OpenRouter is the active provider, your prompts ' +
      '(including vault content attached as context) pass through ' +
      "OpenRouter's API in addition to the underlying model " +
      "provider you select. See OpenRouter's privacy policy at ",
  });
  const link = notice.createEl('a', {
    text: 'openrouter.ai/privacy',
    href: 'https://openrouter.ai/privacy',
  });
  link.setAttr('target', '_blank');
  notice.createSpan({
    text: ", and skald's security model in docs/security-model.md.",
  });

  new Setting(containerEl)
    .setName('API key')
    .setDesc(
      'OpenRouter API key from openrouter.ai. Required — Skald sends requests directly to OpenRouter using this key. Stored in plugin data, synced across your devices via Obsidian Sync.',
    )
    .addText((t) => {
      t.inputEl.type = 'password';
      t.setPlaceholder('sk-or-…')
        .setValue(plugin.settings.openrouterApiKey)
        .onChange(async (v) => {
          plugin.settings.openrouterApiKey = v.trim();
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName('Default model')
    .setDesc(
      'OpenRouter model id (namespaced, e.g. anthropic/claude-opus-4-7, openai/gpt-5.2, meta-llama/llama-3.3-70b-instruct). Type to search the catalog.',
    )
    .addText((t) => {
      t.setPlaceholder('anthropic/claude-sonnet-4-6').setValue(
        plugin.settings.openrouterModel,
      );
      t.onChange(async (v) => {
        plugin.settings.openrouterModel = v.trim();
        await plugin.saveSettings();
      });
      new ModelSuggest(plugin.app, t.inputEl, async (model) => {
        plugin.settings.openrouterModel = model.id;
        await plugin.saveSettings();
      });
    });
}

function renderOpenaiBlock(
  containerEl: HTMLElement,
  plugin: SkaldPlugin,
): void {
  new Setting(containerEl).setName('OpenAI-compatible').setHeading();

  const notice = containerEl.createEl('div', {
    cls: 'skald-privacy-notice',
  });
  notice.createEl('strong', { text: 'Privacy notice. ' });
  notice.createSpan({
    text:
      'When an OpenAI-compatible endpoint is the active provider, your ' +
      'prompts (including vault content attached as context) are sent ' +
      'directly to the base URL you configure below. Point this at an ' +
      'endpoint you trust (e.g. your own self-hosted server). See ' +
      "skald's security model in docs/security-model.md.",
  });

  new Setting(containerEl)
    .setName('Base URL')
    .setDesc(
      'OpenAI-compatible base URL, e.g. https://your-endpoint.example/v1 or ' +
      'http://localhost:11434/v1. Skald appends /chat/completions for utility calls.',
    )
    .addText((t) => {
      t.setPlaceholder('https://your-endpoint.example/v1')
        .setValue(plugin.settings.openaiBaseUrl)
        .onChange(async (v) => {
          const trimmed = v.trim();
          const result = validateOpenAiBaseUrl(trimmed);
          if (!result.ok) {
            t.inputEl.addClass('skald-input-invalid');
            new Notice(`Skald: ${result.error}`);
            // Do not persist an insecure base URL — leave the prior
            // value in place so prompts/keys are never dispatched in
            // cleartext to a remote host.
            return;
          }
          t.inputEl.removeClass('skald-input-invalid');
          plugin.settings.openaiBaseUrl = trimmed;
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName('Model')
    .setDesc(
      'Free-text model id served by your endpoint, e.g. qwen2.5-14b. ' +
      'Pickable per-chat in the chat header.',
    )
    .addText((t) => {
      t.setPlaceholder('qwen2.5-14b')
        .setValue(plugin.settings.openaiModel)
        .onChange(async (v) => {
          plugin.settings.openaiModel = v.trim();
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName('API key')
    .setDesc(
      'Bearer token for the endpoint. Sent as Authorization: Bearer. ' +
      'Leave blank if your endpoint needs no auth. Stored in plugin ' +
      'data, synced across your devices via Obsidian Sync.',
    )
    .addText((t) => {
      t.inputEl.type = 'password';
      t.setPlaceholder('sk-…')
        .setValue(plugin.settings.openaiApiKey)
        .onChange(async (v) => {
          plugin.settings.openaiApiKey = v.trim();
          await plugin.saveSettings();
        });
    });
}
