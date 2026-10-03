import { App, Notice, setIcon } from 'obsidian';
import type { Provider } from '@skald/protocol';
import type { ApiKeys } from '../api-keys';
import type { SkaldSettings } from '../settings';

export interface SetupBannerInput {
  /** Active provider — determines which API key the banner asks for. */
  provider: Provider;
  /** Anthropic API key from secret storage ('' when missing). */
  anthropicApiKey: string;
  /** OpenRouter API key from secret storage ('' when missing). */
  openrouterApiKey: string;
  /** Trimmed OpenAI-compatible base URL from settings. The openai banner
   * gates on a base URL (the key is optional for self-hosted endpoints). */
  openaiBaseUrl: string;
  /** True when a secret is picked for the OpenAI-compatible endpoint but
   * is not in secret storage on this device. A blank pick means no auth. */
  openaiKeyMissing: boolean;
}

/** Banner input for the plugin's current settings and secret-storage keys.
 * A secret that is missing on this device resolves to '' and so shows the
 * banner. */
export function bannerInputFor(plugin: {
  settings: Pick<SkaldSettings, 'provider' | 'openaiBaseUrl' | 'openaiKeySecret'>;
  apiKeys(): ApiKeys;
}): SetupBannerInput {
  const keys = plugin.apiKeys();
  return {
    provider: plugin.settings.provider,
    anthropicApiKey: keys.anthropicApiKey,
    openrouterApiKey: keys.openrouterApiKey,
    openaiBaseUrl: plugin.settings.openaiBaseUrl,
    openaiKeyMissing: plugin.settings.openaiKeySecret !== '' && keys.openaiApiKey === '',
  };
}

/**
 * Pure helper: given the banner input, return a descriptor for what the
 * banner should say, or null if no banner is needed. This makes the
 * decision logic independently testable without a DOM.
 *
 * @internal exported for tests only
 */
export interface BannerSpec {
  title: string;
  detail: string;
}

export function resolveBannerSpec(input: SetupBannerInput): BannerSpec | null {
  // OpenAI-compatible: gate on the base URL, and on the key only when a
  // secret is picked (self-hosted endpoints may need no auth).
  if (input.provider === 'openai') {
    if (!input.openaiBaseUrl.trim()) {
      return {
        title: 'Add your endpoint',
        detail: 'OpenAI-compatible base URL — Settings → Skald (e.g. https://your-endpoint.example/v1 or http://localhost:11434/v1).',
      };
    }
    if (!input.openaiKeyMissing) return null;
    return {
      title: 'Add your API key',
      detail: 'The secret picked for your endpoint is not on this device. Add it in Settings → Skald.',
    };
  }

  const activeKey =
    input.provider === 'openrouter'
      ? input.openrouterApiKey.trim()
      : input.anthropicApiKey.trim();

  if (activeKey) return null;

  if (input.provider === 'openrouter') {
    return {
      title: 'Add your API key',
      detail: 'OpenRouter API key — Settings → Skald. Get one at openrouter.ai/keys.',
    };
  }
  return {
    title: 'Add your API key',
    detail: 'Anthropic API key — Settings → Skald. Get one at console.anthropic.com.',
  };
}

/**
 * First-run setup banner. Shown when the active provider's API key is
 * empty — guides the user to add it before they hit a 401.
 *
 * Mounted at the top of the chat root so it's the first thing a
 * new user sees, above messages + composer.
 */
export function maybeRenderSetupBanner(
  parent: HTMLElement,
  app: App,
  input: SetupBannerInput,
): HTMLDivElement | null {
  const spec = resolveBannerSpec(input);
  if (!spec) return null;

  const banner = parent.createDiv({ cls: 'skald-setup-banner' });
  const icon = banner.createDiv({ cls: 'skald-setup-banner-icon' });
  setIcon(icon, 'plug-zap');
  const body = banner.createDiv({ cls: 'skald-setup-banner-body' });
  body.createDiv({
    cls: 'skald-setup-banner-title',
    text: spec.title,
  });
  body.createDiv({
    cls: 'skald-setup-banner-detail',
    text: spec.detail,
  });
  const action = banner.createEl('button', {
    cls: 'mod-cta skald-setup-banner-action',
    text: 'Open settings',
  });
  action.addEventListener('click', () => openSettingsForPlugin(app));
  return banner;
}

/**
 * Use Obsidian's settings API to open the plugin's settings tab.
 * The settings surface is private API typed as `unknown`-ish on the
 * App type, so we cast through `any` for the call. If the API
 * isn't available (Obsidian rev change, or running in a context
 * without it), we fall back to a Notice telling the user how to
 * find settings manually — better than a silent no-op button.
 */
function openSettingsForPlugin(app: App): void {
  const setting = (
    app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }
  ).setting;
  if (setting && typeof setting.open === 'function') {
    setting.open();
    if (typeof setting.openTabById === 'function') {
      setting.openTabById('skald');
    }
    return;
  }
  new Notice(
    'skald: open Settings → Community plugins → Skald to add your API key.',
    8000,
  );
}
