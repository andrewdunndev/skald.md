/**
 * Diff-card renderer for the write-tool approval flow.
 *
 * The card is a per-message UI element that lists the proposed
 * before/after diff and gives the user approve / reject buttons.
 * State (which approvals are pending) lives in ApprovalManager;
 * this module is the view layer that paints the card and wires the
 * click handlers back into the manager.
 *
 * Extracted from view.ts as part of the LOC-cap refactor; the
 * approval state machine is already its own module (approval-manager.ts).
 */

import { setIcon, setTooltip } from 'obsidian';
import { lineDiff } from '../diff';
import type { WriteProposal } from '../tools';

export interface DiffCardHooks {
  onApprove: (toolUseId: string) => void;
  onReject: (toolUseId: string) => void;
}

const KIND_LABELS: Record<WriteProposal['kind'], string> = {
  create: '🆕 Create',
  overwrite: '✏️ Overwrite',
  edit: '✏️ Edit',
  append: '➕ Append',
};

export function renderDiffCard(
  parent: HTMLElement,
  proposal: WriteProposal,
  hooks: DiffCardHooks,
): void {
  const card = parent.createDiv({ cls: 'scribian-diff' });
  card.setAttr('data-tool-use-id', proposal.toolUseId);

  const header = card.createDiv({ cls: 'scribian-diff-header' });
  header.createSpan({
    cls: 'scribian-diff-kind',
    text: KIND_LABELS[proposal.kind],
  });
  header.createSpan({
    cls: 'scribian-diff-path',
    text: proposal.path,
  });

  const body = card.createDiv({ cls: 'scribian-diff-body' });
  const diff = lineDiff(proposal.before ?? '', proposal.after);
  for (const line of diff) {
    const row = body.createDiv({
      cls: `scribian-diff-line scribian-diff-${line.type}`,
    });
    const marker = row.createSpan({ cls: 'scribian-diff-marker' });
    marker.setText(
      line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ',
    );
    row.createSpan({ cls: 'scribian-diff-text', text: line.text });
  }

  const actions = card.createDiv({ cls: 'scribian-diff-actions' });
  const approve = actions.createEl('button', {
    cls: 'clickable-icon scribian-icon-btn scribian-diff-approve',
    attr: { 'aria-label': 'Approve write' },
  });
  setIcon(approve, 'check');
  setTooltip(approve, 'Approve');
  const reject = actions.createEl('button', {
    cls: 'clickable-icon scribian-icon-btn scribian-diff-reject',
    attr: { 'aria-label': 'Reject write' },
  });
  setIcon(reject, 'x');
  setTooltip(reject, 'Reject');
  approve.addEventListener('click', () => hooks.onApprove(proposal.toolUseId));
  reject.addEventListener('click', () => hooks.onReject(proposal.toolUseId));
}
