/**
 * Worker section of the settings tab: URL, token, test-connection.
 * The Worker is the BYO-deployed Cloudflare endpoint that fronts
 * Anthropic / OpenRouter; users configure it once per device.
 */

import { Notice, Setting } from 'obsidian';
import type ScribianPlugin from '../main';

export function renderWorkerSection(
  containerEl: HTMLElement,
  plugin: ScribianPlugin,
): void {
  new Setting(containerEl).setName('Worker').setHeading();

  new Setting(containerEl)
    .setName('Worker URL')
    .setDesc(
      'wss:// URL of your Cloudflare Worker. Run `pnpm deploy` in packages/worker to get one.',
    )
    .addText((t) =>
      t
        .setPlaceholder('wss://scribian.username.workers.dev')
        .setValue(plugin.settings.workerUrl)
        .onChange(async (v) => {
          plugin.settings.workerUrl = v.trim();
          await plugin.saveSettings();
        }),
    );

  new Setting(containerEl)
    .setName('Worker token')
    .setDesc(
      'Bearer token matching the Worker secret SCRIBIAN_TOKEN. Generate with `openssl rand -hex 32`.',
    )
    .addText((t) => {
      t.inputEl.type = 'password';
      t.setPlaceholder('hex token')
        .setValue(plugin.settings.workerToken)
        .onChange(async (v) => {
          plugin.settings.workerToken = v.trim();
          await plugin.saveSettings();
        });
    });

  new Setting(containerEl)
    .setName('Test connection')
    .setDesc(
      'Hits the Worker /health endpoint. Confirms the URL is reachable; does NOT verify the token.',
    )
    .addButton((b) =>
      b
        .setButtonText('Test')
        .onClick(() => void testWorkerHealth(plugin)),
    );
}

/**
 * Hit the Worker's /health endpoint and surface the result as a
 * Notice. Doesn't validate SCRIBIAN_TOKEN — that only matters on
 * WebSocket upgrades.
 */
async function testWorkerHealth(plugin: ScribianPlugin): Promise<void> {
  const url = plugin.settings.workerUrl.trim();
  if (!url) {
    new Notice('Set the Worker URL first.');
    return;
  }
  const httpUrl = url.replace(/^ws/, 'http').replace(/\/$/, '') + '/health';
  try {
    const resp = await fetch(httpUrl);
    if (!resp.ok) {
      new Notice(`Worker returned ${resp.status}`);
      return;
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const aig = data.ai_gateway ? ' · AI Gateway on' : '';
    const key = data.anthropic_key_present ? ' · Worker key set' : '';
    new Notice(`Worker OK (v${data.version ?? '?'})${aig}${key}`, 5000);
  } catch (err) {
    new Notice(
      `Connection failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}
