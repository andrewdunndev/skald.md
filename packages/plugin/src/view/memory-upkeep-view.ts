/**
 * View-layer integration for vault-memory upkeep.
 *
 * Bridges the pure memory-upkeep.ts module (which handles model calls
 * and returns a proposed new note body) with the view-layer concerns
 * (vault I/O, approval routing, plugin settings). Extracted from
 * view.ts to keep that file under the 400-line cap.
 */

import { Notice, TFile, normalizePath, type App } from 'obsidian';
import type { Provider } from '../protocol';
import type { ApprovalManager } from '../approval-manager';
import { proposeMemoryUpkeep } from '../memory-upkeep';
import { utilityModel } from '../provider-capabilities';
import type { SkaldSettings } from '../settings';
import { keyForProvider, type ApiKeys } from '../api-keys';
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
  settings: SkaldSettings;
  /** Keys resolved from secret storage for this pass. */
  apiKeys: ApiKeys;
  session: ChatSession | null;
  approvals: ApprovalManager;
  provider: Provider | undefined;
  /** Returns the conversationId of the session that is CURRENTLY active.
   * Snapshotted at trigger time and re-checked before the vault write so a
   * new chat / resume mid-flight aborts the write (it would otherwise
   * clobber the memory note with a proposal built from a different
   * conversation's messages). */
  getActiveConversationId?: () => string | undefined;
  /** Shared in-flight gate owned by the caller (the view). Only one upkeep
   * pass may run / await approval at a time; a second trigger while one is
   * pending must skip, otherwise two overlapping overwrite proposals can
   * race against the same note and the last-approved silently clobbers. */
  inFlight?: UpkeepInFlightGate;
}): Promise<void> {
  const { app, settings, apiKeys, session, approvals, provider, getActiveConversationId, inFlight } = opts;
  if (!settings.memoryEnabled || !settings.memoryPath?.trim()) return;

  // In-flight guard: bail immediately if a pass is already running/awaiting
  // approval. Claim the gate before any await; release in `finally`.
  if (inFlight?.isActive()) return;
  inFlight?.acquire();
  try {
    const resolvedProvider = provider ?? settings.provider ?? 'anthropic';
    const apiKey = keyForProvider(resolvedProvider, apiKeys);
    const baseUrl = resolvedProvider === 'openai' ? settings.openaiBaseUrl : undefined;
    // OpenAI-compatible endpoints may need no key; gate on base URL instead.
    if (resolvedProvider === 'openai') {
      if (!baseUrl) return;
    } else if (!apiKey) {
      return;
    }

    // Snapshot the conversation identity at trigger time. The model call and
    // approval dialog are async; if the user starts a new chat or resumes a
    // different conversation while this is in flight, the snapshot will no
    // longer match the active conversationId and we bail before writing.
    const conversationIdAtTrigger = session?.conversationId;

    const memoryBody = await readVaultNote(app, settings.memoryPath);
    const messages = session?.getMessages() ?? [];
    if (messages.length === 0) return;

    const proposed = await proposeMemoryUpkeep({
      memoryBody,
      messages,
      model: utilityModel(settings),
      provider: resolvedProvider,
      apiKey,
      baseUrl,
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

    // conversationId race guard: if the active conversation changed between
    // trigger and write (new chat / resume happened during the model call or
    // while the approval dialog was open), abort — this proposal was built
    // against a conversation that is no longer current.
    if (getActiveConversationId) {
      const active = getActiveConversationId();
      if (active !== conversationIdAtTrigger) {
        console.warn(
          '[memory-upkeep] conversation changed between trigger and write — skipping stale overwrite',
        );
        return;
      }
    }

    // TOCTOU-guarded write. `memoryBody` is the snapshot shown to the user
    // in the approval diff card (the `before`). Re-read the on-disk content
    // INSIDE app.vault.process and abort if it diverged — a concurrent
    // manual edit (another pane, sync) between the diff card and this commit
    // would otherwise be silently clobbered. Losing a hand-edited memory
    // note is the worst outcome in a live family vault.
    await writeMemoryNoteGuarded(app, settings.memoryPath, memoryBody, proposed);
  } finally {
    inFlight?.release();
  }
}

/**
 * A single-slot in-flight gate. Owned by the view so its state persists
 * across the `void`-fired upkeep calls. Kept as a tiny object (not a bare
 * boolean) so the caller holds a stable reference the function can mutate.
 */
export class UpkeepInFlightGate {
  private active = false;
  isActive(): boolean { return this.active; }
  acquire(): void { this.active = true; }
  release(): void { this.active = false; }
}

/** Read a vault note by path, returning empty string if absent. */
async function readVaultNote(app: App, path: string): Promise<string> {
  const normalized = normalizePath(path);
  const file = app.vault.getAbstractFileByPath(normalized);
  if (!(file instanceof TFile)) return '';
  try { return await app.vault.cachedRead(file); } catch { return ''; }
}

/**
 * Write the memory note with a TOCTOU guard, mirroring runWriteNote in
 * tools/write.ts (the one guarded write primitive). `snapshot` is the
 * on-disk content that was read at trigger time and shown to the user in
 * the approval diff card. For an existing note we re-read the live content
 * INSIDE app.vault.process and only commit if it still equals `snapshot`;
 * if it diverged (a concurrent manual edit) we abort and surface a Notice
 * rather than overwriting the user's edit. For a new note (snapshot is the
 * empty string and no file exists) there is nothing to clobber, so we
 * create it.
 */
async function writeMemoryNoteGuarded(
  app: App,
  path: string,
  snapshot: string,
  body: string,
): Promise<void> {
  const normalized = normalizePath(path);
  const existing = app.vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFile) {
    let diverged = false;
    try {
      await app.vault.process(existing, (current) => {
        if (current !== snapshot) {
          diverged = true;
          // Return current unchanged — vault.process requires a string return.
          return current;
        }
        return body;
      });
    } catch (err) {
      console.warn('[memory-upkeep] vault write failed —', err);
      new Notice('Skald: memory-note update failed — see console.');
      return;
    }
    if (diverged) {
      console.warn(
        '[memory-upkeep] memory note changed since the proposal was shown — aborting overwrite to preserve the manual edit',
      );
      new Notice(
        'Skald: memory note changed since the proposal — update skipped to protect your edit.',
      );
    }
    return;
  }
  try {
    const folder = normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : '';
    if (folder && !app.vault.getAbstractFileByPath(folder)) {
      await app.vault.createFolder(folder);
    }
    await app.vault.create(normalized, body);
  } catch (err) {
    console.warn('[memory-upkeep] vault write failed —', err);
    new Notice('Skald: memory-note update failed — see console.');
  }
}
