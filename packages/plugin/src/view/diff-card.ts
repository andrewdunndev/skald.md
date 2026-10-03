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
import { haptic } from './haptics';

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
  const card = parent.createDiv({ cls: 'skald-diff' });
  card.setAttr('data-tool-use-id', proposal.toolUseId);
  // Group the approve/reject controls + diff under one labelled
  // landmark so screen readers announce what's being approved when
  // focus lands inside, rather than reading orphaned + / − lines.
  card.setAttrs({
    role: 'group',
    'aria-label': `Write proposal: ${proposal.kind} ${proposal.path}`,
  });

  const header = card.createDiv({ cls: 'skald-diff-header' });
  header.createSpan({
    cls: 'skald-diff-kind',
    text: KIND_LABELS[proposal.kind],
  });
  header.createSpan({
    cls: 'skald-diff-path',
    text: proposal.path,
  });

  if (proposal.informedBy && proposal.informedBy.length > 0) {
    const trace = card.createDiv({ cls: 'skald-diff-trace' });
    trace.createSpan({
      cls: 'skald-diff-trace-label',
      text: 'Informed by: ',
    });
    for (let i = 0; i < proposal.informedBy.length; i++) {
      if (i > 0) trace.createSpan({ text: ', ' });
      trace.createSpan({
        cls: 'skald-diff-trace-source',
        text: proposal.informedBy[i],
      });
    }
  }

  const body = card.createDiv({ cls: 'skald-diff-body' });
  const diff = lineDiff(proposal.before ?? '', proposal.after);
  for (const line of diff) {
    const row = body.createDiv({
      cls: `skald-diff-line skald-diff-${line.type}`,
    });
    const marker = row.createSpan({ cls: 'skald-diff-marker' });
    marker.setText(
      line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ',
    );
    row.createSpan({ cls: 'skald-diff-text', text: line.text });
  }

  const actions = card.createDiv({ cls: 'skald-diff-actions' });
  const approve = actions.createEl('button', {
    cls: 'clickable-icon skald-icon-btn skald-diff-approve',
    attr: { 'aria-label': 'Approve write' },
  });
  setIcon(approve, 'check');
  setTooltip(approve, 'Approve');
  const reject = actions.createEl('button', {
    cls: 'clickable-icon skald-icon-btn skald-diff-reject',
    attr: { 'aria-label': 'Reject write' },
  });
  setIcon(reject, 'x');
  setTooltip(reject, 'Reject');
  approve.addEventListener('click', () => {
    haptic('approve');
    hooks.onApprove(proposal.toolUseId);
  });
  reject.addEventListener('click', () => {
    haptic('reject');
    hooks.onReject(proposal.toolUseId);
  });

  // Do NOT auto-focus the approve button here.  Stealing focus from
  // the composer textarea breaks mobile keyboard workflows: the
  // software keyboard collapses, scroll position jumps, and focus is
  // left on <body> after approve/reject resolves.  Instead the view
  // layer (resolveApprovalUi in view.ts) restores focus to the
  // composer after a decision is made, keeping the UX intentional
  // rather than incidental.  CDP / on-device tests cover the
  // round-trip behaviour.
}
