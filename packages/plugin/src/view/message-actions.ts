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
import type { Message } from '@scribian/protocol';
import {
  formatSummary,
  hasAnyAction,
  summarizeVaultActions,
} from './vault-action-summary';

export interface MessageActionsConfig {
  app: App;
  savedNotesFolder: string;
}

export function renderMessageActions(
  row: HTMLElement,
  msg: Message,
  cfg: MessageActionsConfig,
): void {
  renderVaultActionBadge(row, msg);
  const actions = row.createDiv({ cls: 'scribian-msg-actions' });
  const text = messageText(msg);

  const copyBtn = actions.createEl('button', {
    cls: 'clickable-icon scribian-msg-action',
    attr: { 'aria-label': 'Copy message' },
  });
  setIcon(copyBtn, 'copy');
  setTooltip(copyBtn, 'Copy');
  copyBtn.addEventListener('click', () => void copyMessage(text, copyBtn));

  const saveBtn = actions.createEl('button', {
    cls: 'clickable-icon scribian-msg-action',
    attr: { 'aria-label': 'Save as note' },
  });
  setIcon(saveBtn, 'file-plus');
  setTooltip(saveBtn, 'Save as new note');
  saveBtn.addEventListener('click', () => void saveAsNote(cfg, text));

  const appendBtn = actions.createEl('button', {
    cls: 'clickable-icon scribian-msg-action',
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
    // Brief visual ack — swap the icon to a check for ~1s.
    setIcon(btn, 'check');
    setTimeout(() => setIcon(btn, 'copy'), 1200);
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
  const folder = cfg.savedNotesFolder.trim() || 'Scribian/Saved';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = normalizePath(`${folder}/${ts}.md`);
  try {
    const folderItem = cfg.app.vault.getAbstractFileByPath(folder);
    if (!folderItem) await cfg.app.vault.createFolder(folder);
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
 * Vault-action badge — a thin line above the action row summarizing
 * what tools the assistant turn touched. Visible signal of the
 * "default to vault action" prompt working. When nothing fired, an
 * italic "no vault action" reminds the user to ask "where would
 * this land?"
 */
function renderVaultActionBadge(row: HTMLElement, msg: Message): void {
  const summary = summarizeVaultActions(msg);
  const badge = row.createDiv({ cls: 'scribian-vault-badge' });
  if (hasAnyAction(summary)) {
    badge.setText(formatSummary(summary));
    badge.addClass('scribian-vault-badge-active');
  } else {
    badge.setText('💭 no vault action');
    badge.addClass('scribian-vault-badge-idle');
    setTooltip(
      badge,
      "Claude answered without reading or writing to your vault. If you want this in a note, ask: 'where should this land?'",
    );
  }
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
    const existing = await cfg.app.vault.read(file);
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    await cfg.app.vault.modify(file, existing + sep + text);
    new Notice(`Appended to ${file.basename}`);
  } catch (err) {
    new Notice(
      `Append failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}
