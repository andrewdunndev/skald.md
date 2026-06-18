/**
 * View-layer integration for vault-memory upkeep.
 *
 * Bridges the pure memory-upkeep.ts module (which handles model calls
 * and returns a proposed new note body) with the view-layer concerns
 * (vault I/O, approval routing, plugin settings). Extracted from
 * view.ts to keep that file under the 400-line cap.
 */

import { TFile, normalizePath, type App } from 'obsidian';
import type { Provider } from '@scribian/protocol';
import type { ApprovalManager } from '../approval-manager';
import { proposeMemoryUpkeep } from '../memory-upkeep';
import { utilityModel } from '../provider-capabilities';
import type { ScribianSettings } from '../settings';
import type { ChatSession } from '../chat-session';

/**
 * Off-hot-path: propose a memory-note update via the utility model and
 * surface it through the approval diff card. Called after onTurnDone
 * when the upkeep cadence is due.
 *
 * Soft-fail: any error is swallowed with a console.warn; the caller
 * must fire this with `void` (no await) to keep it off the hot path.
 */
export async function runMemoryUpkeepView(opts: {
  app: App;
  settings: ScribianSettings;
  session: ChatSession | null;
  approvals: ApprovalManager;
  provider: Provider | undefined;
}): Promise<void> {
  const { app, settings, session, approvals, provider } = opts;
  if (!settings.memoryEnabled || !settings.memoryPath?.trim()) return;

  const resolvedProvider = provider ?? settings.provider ?? 'anthropic';
  const apiKey = resolvedProvider === 'openrouter'
    ? settings.openrouterApiKey
    : settings.anthropicApiKey;
  if (!apiKey) return;

  const memoryBody = await readVaultNote(app, settings.memoryPath);
  const messages = session?.getMessages() ?? [];
  if (messages.length === 0) return;

  const proposed = await proposeMemoryUpkeep({
    memoryBody,
    messages,
    model: utilityModel(settings),
    provider: resolvedProvider,
    apiKey,
  });
  if (!proposed) return;

  const toolUseId = crypto.randomUUID();
  const approved = await approvals.request({
    toolUseId,
    kind: 'overwrite',
    path: settings.memoryPath,
    before: memoryBody || null,
    after: proposed,
  });
  if (!approved) return;

  await writeVaultNote(app, settings.memoryPath, proposed);
}

/** Read a vault note by path, returning empty string if absent. */
async function readVaultNote(app: App, path: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) return '';
  try { return await app.vault.cachedRead(file); } catch { return ''; }
}

/** Write (create or overwrite) a vault note by path. */
async function writeVaultNote(app: App, path: string, body: string): Promise<void> {
  try {
    const normalized = normalizePath(path);
    const existing = app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, body);
      return;
    }
    const folder = normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : '';
    if (folder && !app.vault.getAbstractFileByPath(folder)) {
      await app.vault.createFolder(folder);
    }
    await app.vault.create(normalized, body);
  } catch (err) {
    console.warn('[memory-upkeep] vault write failed —', err);
  }
}
