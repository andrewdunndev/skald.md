/**
 * Connection mode section of the settings tab.
 *
 * 'direct': plugin calls Anthropic / OpenRouter directly from the Obsidian
 * client. No Worker required. Uses the dangerous-direct-browser-access
 * header for Anthropic. Semantic search (find_related) is unavailable
 * because it requires the Worker's Vectorize binding.
 *
 * 'worker': plugin connects to a user-deployed Cloudflare Worker over
 * WebSocket. Full feature set including semantic search. Requires Worker
 * URL + token.
 *
 * Migration: on first load after the upgrade, migrateConnectionMode()
 * detects an existing Worker URL and preserves 'worker' so users who
 * already have a Worker configured don't have to reconfigure.
 */

import { Notice, Setting, requestUrl } from 'obsidian';
import type ScribianPlugin from '../main';
import type { ConnectionMode } from '../settings';

export function renderConnectionModeSection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
  redisplay: () => void,
): void {
  new Setting(containerEl).setName('Connection').setHeading();

  new Setting(containerEl)
    .setName('Connection mode')
    .setDesc(
      'Direct: calls Anthropic / OpenRouter from this device — no Worker required, but semantic search (find_related) is unavailable. ' +
        'Worker: tunnels through your Cloudflare Worker — full feature set including semantic search.',
    )
    .addDropdown((d) => {
      d.addOption('direct', 'Direct (no Worker)');
      d.addOption('worker', 'Worker (self-hosted)');
      d.setValue(plugin.settings.connectionMode).onChange(async (v) => {
        plugin.settings.connectionMode = v as ConnectionMode;
        await plugin.saveSettings();
        redisplay();
      });
    });

  if (plugin.settings.connectionMode === 'direct') {
    new Setting(containerEl)
      .setName('Test connection')
      .setDesc(
        'Verifies the Anthropic API key by listing available models.',
      )
      .addButton((b) =>
        b
          .setButtonText('Test')
          .onClick(() => void testDirectConnection(plugin)),
      );
  }
}

/**
 * Test the direct Anthropic connection by hitting GET /v1/models.
 * Uses Obsidian requestUrl (bypasses CORS) since this is a simple
 * authenticated GET — not a streaming fetch. The dangerous-direct-
 * browser-access header is only required for the /v1/messages endpoint.
 */
async function testDirectConnection(plugin: ScribianPlugin): Promise<void> {
  const key = plugin.settings.anthropicApiKey.trim();
  if (!key) {
    new Notice('Set the Anthropic API key first (Provider section below).');
    return;
  }
  try {
    const resp = await requestUrl({
      url: 'https://api.anthropic.com/v1/models',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      throw: false,
    });
    if (resp.status === 200) {
      const data = resp.json as { data?: { id: string }[] };
      const count = data.data?.length ?? 0;
      new Notice(`Anthropic key OK — ${count} model(s) available.`, 5000);
    } else if (resp.status === 401) {
      new Notice('Anthropic key invalid (401). Check the key in Provider settings.', 7000);
    } else {
      new Notice(
        `Anthropic returned ${resp.status}: ${resp.text.slice(0, 200)}`,
        7000,
      );
    }
  } catch (err) {
    new Notice(
      `Connection failed: ${err instanceof Error ? err.message : 'unknown'}`,
      7000,
    );
  }
}

/**
 * Migration helper: call once in loadSettings() to set a sensible
 * default for connectionMode when upgrading from a version that didn't
 * have the field.
 *
 * Rules:
 *   - If connectionMode is already set → leave it alone.
 *   - If workerUrl is non-empty in the stored data → default to 'worker'
 *     (user has a Worker configured; preserve their setup).
 *   - Otherwise → default to 'direct' (fresh install or unconfigured).
 *
 * Accepts the raw stored object rather than ScribianSettings so it can
 * inspect the persisted state before defaults are merged.
 */
export function migrateConnectionMode(
  stored: Partial<Record<string, unknown>>,
): ConnectionMode {
  // Already explicitly set — respect it.
  if (stored.connectionMode === 'direct' || stored.connectionMode === 'worker') {
    return stored.connectionMode;
  }
  // Upgrading: if a Worker URL was configured, stay on worker mode.
  if (typeof stored.workerUrl === 'string' && stored.workerUrl.trim()) {
    return 'worker';
  }
  return 'direct';
}
