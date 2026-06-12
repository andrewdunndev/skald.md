import { App, Notice, setIcon } from 'obsidian';
import type { Provider } from '@scribian/protocol';
import type { ConnectionMode } from '../settings';
import { modeCapabilities } from '../mode-capabilities';

export interface SetupBannerInput {
  /** Current connection mode — resolved by resolveConnectionMode before
   * reaching here. Capability lookup determines whether a banner is needed;
   * no inline mode-string comparisons. */
  connectionMode: ConnectionMode;
  workerUrl: string;
  workerToken: string;
  /** Active provider (direct mode only — ignored in worker mode). */
  provider: Provider;
  /** Trimmed Anthropic API key from settings (direct mode). */
  anthropicApiKey: string;
  /** Trimmed OpenRouter API key from settings (direct mode). */
  openrouterApiKey: string;
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
  const caps = modeCapabilities(input.connectionMode);

  if (caps.banner === 'worker') {
    if (input.workerUrl && input.workerToken) return null;
    const missing: string[] = [];
    if (!input.workerUrl) missing.push('Worker URL');
    if (!input.workerToken) missing.push('Worker token');
    return {
      title: 'Connect scribian to your Worker',
      detail: `Missing: ${missing.join(' + ')}. See docs/deploying-the-worker.md, or paste an obsidian://scribian-setup link from your desktop.`,
    };
  }

  // direct mode
  const activeKey =
    input.provider === 'openrouter'
      ? input.openrouterApiKey.trim()
      : input.anthropicApiKey.trim();

  if (activeKey) return null;

  if (input.provider === 'openrouter') {
    return {
      title: 'Add your API key',
      detail: 'OpenRouter API key — Settings → Scribian. Get one at openrouter.ai/keys.',
    };
  }
  return {
    title: 'Add your API key',
    detail: 'Anthropic API key — Settings → Scribian. Get one at console.anthropic.com.',
  };
}

/**
 * First-run setup banner. In worker mode: shown when workerUrl OR
 * workerToken is empty — names the missing piece and opens settings.
 * In direct mode: shown when the active provider's API key is empty —
 * guides the user to add it before they hit a 401.
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

  const banner = parent.createDiv({ cls: 'scribian-setup-banner' });
  const icon = banner.createDiv({ cls: 'scribian-setup-banner-icon' });
  setIcon(icon, 'plug-zap');
  const body = banner.createDiv({ cls: 'scribian-setup-banner-body' });
  body.createDiv({
    cls: 'scribian-setup-banner-title',
    text: spec.title,
  });
  body.createDiv({
    cls: 'scribian-setup-banner-detail',
    text: spec.detail,
  });
  const action = banner.createEl('button', {
    cls: 'mod-cta scribian-setup-banner-action',
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
  const setting = (app as any).setting;
  if (setting && typeof setting.open === 'function') {
    setting.open();
    if (typeof setting.openTabById === 'function') {
      setting.openTabById('scribian');
    }
    return;
  }
  new Notice(
    'scribian: open Settings → Community plugins → Scribian to add your Worker URL + token.',
    8000,
  );
}
