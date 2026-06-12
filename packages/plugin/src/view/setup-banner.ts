import { App, Notice, setIcon } from 'obsidian';

export interface SetupBannerInput {
  /** Current connection mode — banner only shows in worker mode when
   * the Worker URL or token is missing. In direct mode the plugin
   * works immediately; no banner needed. */
  connectionMode: 'direct' | 'worker';
  workerUrl: string;
  workerToken: string;
}

/**
 * First-run setup banner. In worker mode: shown when workerUrl OR
 * workerToken is empty — names the missing piece and opens settings.
 * In direct mode: always returns null (plugin works without a Worker).
 *
 * Mounted at the top of the chat root so it's the first thing a
 * new user sees, above messages + composer.
 */
export function maybeRenderSetupBanner(
  parent: HTMLElement,
  app: App,
  input: SetupBannerInput,
): HTMLDivElement | null {
  if (input.connectionMode === 'direct') return null;
  if (input.workerUrl && input.workerToken) return null;
  const banner = parent.createDiv({ cls: 'scribian-setup-banner' });
  const icon = banner.createDiv({ cls: 'scribian-setup-banner-icon' });
  setIcon(icon, 'plug-zap');
  const body = banner.createDiv({ cls: 'scribian-setup-banner-body' });
  body.createDiv({
    cls: 'scribian-setup-banner-title',
    text: 'Connect scribian to your Worker',
  });
  const missing: string[] = [];
  if (!input.workerUrl) missing.push('Worker URL');
  if (!input.workerToken) missing.push('Worker token');
  body.createDiv({
    cls: 'scribian-setup-banner-detail',
    text: `Missing: ${missing.join(' + ')}. See docs/deploying-the-worker.md, or paste an obsidian://scribian-setup link from your desktop.`,
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
