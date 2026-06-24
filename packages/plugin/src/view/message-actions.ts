/**
 * Per-message Copy / Save-as-note / Append-to-current action row.
 *
 * Always-visible (no hover) so mobile users can reach the actions
 * by tap. Each action is a single icon button; the cluster sits at
 * the bottom of every finalized assistant turn.
 *
 * Extracted from view.ts as part of the LOC-cap refactor. Pure UI
 * + vault I/O; takes the app + savedNotesFolder via a config object
 * so it doesn't reach into the plugin instance.
 */

import {
  Notice,
  normalizePath,
  setIcon,
  setTooltip,
  type App,
} from 'obsidian';
import type { Message } from '@skald/protocol';
import {
  formatSummary,
  hasAnyAction,
  summarizeVaultActions,
} from './vault-action-summary';
import {
  extractMentionedPaths,
  unwrittenMentions,
} from './mention-extraction';
import { notesReadInTurn } from './inflight-reads';

export interface MessageActionsConfig {
  app: App;
  savedNotesFolder: string;
  /** Called when the user taps a "Propose write to X.md" nudge.
   * Host fills the composer with a follow-up prompt and lets the
   * user send. */
  onSuggestWrite?: (path: string) => void;
}

export function renderMessageActions(
  row: HTMLElement,
  msg: Message,
  cfg: MessageActionsConfig,
): void {
  renderVaultActionBadge(row, msg);
  renderSourcesFooter(row, msg, cfg.app);
  renderWriteNudges(row, msg, cfg);
  const actions = row.createDiv({ cls: 'skald-msg-actions' });
  const text = messageText(msg);

  const copyBtn = actions.createEl('button', {
    cls: 'clickable-icon skald-msg-action',
    attr: { 'aria-label': 'Copy message' },
  });
  setIcon(copyBtn, 'copy');
  setTooltip(copyBtn, 'Copy');
  copyBtn.addEventListener('click', () => void copyMessage(text, copyBtn));

  const saveBtn = actions.createEl('button', {
    cls: 'clickable-icon skald-msg-action',
    attr: { 'aria-label': 'Save as note' },
  });
  setIcon(saveBtn, 'file-plus');
  setTooltip(saveBtn, 'Save as new note');
  saveBtn.addEventListener('click', () => void saveAsNote(cfg, text));

  const appendBtn = actions.createEl('button', {
    cls: 'clickable-icon skald-msg-action',
    attr: { 'aria-label': 'Append to current note' },
  });
  setIcon(appendBtn, 'file-down');
  setTooltip(appendBtn, 'Append to current note');
  appendBtn.addEventListener('click', () => void appendToCurrent(cfg, text));
}

/**
 * Concatenate the message's textual content for copy / save
 * operations. Skips thinking blocks, tool calls, images — returns
 * what the user sees rendered as text.
 */
export function messageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  const parts: string[] = [];
  for (const block of msg.content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n\n');
}

async function copyMessage(
  text: string,
  btn: HTMLButtonElement,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    // Brief visual ack — swap the icon to a check for ~1s. Guard the
    // revert: if the view detached (row removed) before the timer
    // fired, btn.isConnected is false and we skip touching a stale
    // node — no setIcon on an orphaned element.
    setIcon(btn, 'check');
    setTimeout(() => {
      if (btn.isConnected) setIcon(btn, 'copy');
    }, 1200);
  } catch {
    new Notice('Copy failed');
  }
}

async function saveAsNote(
  cfg: MessageActionsConfig,
  text: string,
): Promise<void> {
  if (!text.trim()) {
    new Notice('Nothing to save');
    return;
  }
  const folder = cfg.savedNotesFolder.trim() || 'Skald/Saved';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    const folderItem = cfg.app.vault.getAbstractFileByPath(folder);
    if (!folderItem) await cfg.app.vault.createFolder(folder);
    // Second-precision timestamps collide when two messages are saved in
    // the same second — without a unique suffix the second save would
    // overwrite (or, on a strict vault, throw) and the note would be lost.
    // Probe for a free path, appending -2, -3, … on collision.
    const path = uniqueSavePath(cfg.app, folder, ts);
    const created = await cfg.app.vault.create(path, text);
    new Notice(`Saved to ${path}`);
    cfg.app.workspace.openLinkText(created.path, '', false);
  } catch (err) {
    new Notice(
      `Save failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

/**
 * Build a vault path under `folder` for a `base`-named note that does not
 * already exist. Returns `<folder>/<base>.md` when free, else the first
 * free `<folder>/<base>-N.md` (N ≥ 2). Bounded probe so a pathological
 * vault can't spin forever; falls back to a random suffix at the cap.
 */
export function uniqueSavePath(app: App, folder: string, base: string): string {
  const first = normalizePath(`${folder}/${base}.md`);
  if (!app.vault.getAbstractFileByPath(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = normalizePath(`${folder}/${base}-${n}.md`);
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  // Astronomically unlikely; keep the save rather than failing.
  const rand = Math.random().toString(36).slice(2, 8);
  return normalizePath(`${folder}/${base}-${rand}.md`);
}

/**
 * Mid-turn write nudge. When Claude SAYS "I'd add this to X.md" but
 * doesn't emit a write tool call, surface a chip per unwritten
 * mention. Tapping the chip lets the host fill the composer with a
 * follow-up prompt asking Claude to actually propose the write.
 * Closes the say-do gap that's the real risk of the vault-action
 * default — the model that knows where it should land but never
 * proposes the write.
 */
function renderWriteNudges(
  row: HTMLElement,
  msg: Message,
  cfg: MessageActionsConfig,
): void {
  if (!cfg.onSuggestWrite) return;
  const text = messageText(msg);
  if (!text.trim()) return;
  const summary = summarizeVaultActions(msg);
  const mentioned = extractMentionedPaths(text);
  const unwritten = unwrittenMentions(mentioned, summary.writes);
  if (unwritten.length === 0) return;
  const wrap = row.createDiv({ cls: 'skald-write-nudges' });
  for (const path of unwritten) {
    const chip = wrap.createEl('button', {
      cls: 'skald-write-nudge',
      attr: { type: 'button' },
      text: `Propose write to ${path}`,
    });
    chip.addEventListener('click', () => cfg.onSuggestWrite?.(path));
  }
}

/**
 * Sources footer — compact "Sources: [[A.md]], [[B.md]]" line
 * rendered under assistant messages that read vault notes. Each
 * path is an Obsidian internal-link anchor so the user can tap
 * through to the note. Capped at 5 shown; "+N more" appended as
 * plain text when the turn read more. Renders nothing when no
 * note paths were collected.
 */
function renderSourcesFooter(
  row: HTMLElement,
  msg: Message,
  app: App,
): void {
  const content = typeof msg.content === 'string' ? [] : msg.content;
  const paths = notesReadInTurn(content);
  if (paths.length === 0) return;

  const CAP = 5;
  const shown = paths.slice(0, CAP);
  const overflow = paths.length - CAP;

  const footer = row.createDiv({ cls: 'skald-sources-footer' });
  footer.createSpan({ text: 'Sources: ' });

  shown.forEach((path, i) => {
    if (i > 0) footer.createSpan({ text: ', ' });
    const a = footer.createEl('a', {
      cls: 'internal-link',
      text: `[[${path}]]`,
      attr: {
        'data-href': path,
        href: path,
      },
    });
    a.addEventListener('click', (e) => {
      e.preventDefault();
      void app.workspace.openLinkText(path, '', false);
    });
  });

  if (overflow > 0) {
    footer.createSpan({ text: ` +${overflow} more` });
  }
}

/**
 * Vault-action badge — a thin line summarizing what the vault touched on
 * this turn. Only rendered when there IS an action.
 *
 * The old design also showed an idle "no vault action" badge when nothing
 * fired. In practice that was pure noise (it rendered on every plain-text
 * turn) AND read as a false negative: an edit's `tool_use` lives on the
 * assistant turn while its result lands on the NEXT turn, so the turn that
 * requested an edit showed "no vault action" even though it edited. Absence
 * of a badge already communicates "no vault change," so we suppress the idle
 * case entirely.
 */
function renderVaultActionBadge(row: HTMLElement, msg: Message): void {
  const summary = summarizeVaultActions(msg);
  if (!hasAnyAction(summary)) return;
  const badge = row.createDiv({ cls: 'skald-vault-badge' });
  badge.setText(formatSummary(summary));
  badge.addClass('skald-vault-badge-active');
}

async function appendToCurrent(
  cfg: MessageActionsConfig,
  text: string,
): Promise<void> {
  const file = cfg.app.workspace.getActiveFile();
  if (!file || file.extension !== 'md') {
    new Notice('No active note to append to');
    return;
  }
  try {
    // vault.process atomically appends against current on-disk
    // content — handles the case where the active note has
    // unsaved editor edits without clobbering them.
    await cfg.app.vault.process(file, (current) => {
      const sep = current.endsWith('\n') ? '\n' : '\n\n';
      return current + sep + text;
    });
    new Notice(`Appended to ${file.basename}`);
  } catch (err) {
    new Notice(
      `Append failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}
