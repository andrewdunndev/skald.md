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

/** Horizontal swipe threshold (px) to fire approve/reject via
 * gesture. Higher than typical accidental drift; low enough that
 * a confident swipe is comfortable. */
const SWIPE_THRESHOLD_PX = 70;

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

  attachSwipeGesture(card, proposal, hooks);

  // Move focus to Approve when the card mounts so keyboard + screen
  // reader users land on the primary action (and hear the group's
  // aria-label) without hunting. Deferred a tick so the element is
  // attached + focusable before we call focus().
  window.setTimeout(() => {
    if (approve.isConnected) approve.focus();
  }, 0);
}

/**
 * Touch-only swipe gesture: drag the diff card right to approve,
 * left to reject. The visual displacement during the drag is the
 * feedback; crossing SWIPE_THRESHOLD_PX commits the decision.
 *
 * passive: true on the listeners — we don't preventDefault scroll,
 * we just snap the card visually. Vertical scrolling continues to
 * work normally. Mouse drags are ignored deliberately; desktop
 * users have the icon buttons.
 */
function attachSwipeGesture(
  card: HTMLDivElement,
  proposal: WriteProposal,
  hooks: DiffCardHooks,
): void {
  let startX = 0;
  let startY = 0;
  let active = false;
  card.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      active = true;
    },
    { passive: true },
  );
  card.addEventListener(
    'touchmove',
    (e) => {
      if (!active) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      // If the gesture is more vertical than horizontal, defer to
      // native scroll instead of hijacking it.
      if (Math.abs(dy) > Math.abs(dx)) {
        active = false;
        card.style.transform = '';
        return;
      }
      card.style.transform = `translate3d(${dx}px, 0, 0)`;
    },
    { passive: true },
  );
  const finish = (e: TouchEvent): void => {
    if (!active) return;
    active = false;
    const t = e.changedTouches[0];
    const dx = t ? t.clientX - startX : 0;
    card.style.transform = '';
    if (dx >= SWIPE_THRESHOLD_PX) {
      haptic('approve');
      hooks.onApprove(proposal.toolUseId);
    } else if (dx <= -SWIPE_THRESHOLD_PX) {
      haptic('reject');
      hooks.onReject(proposal.toolUseId);
    }
  };
  card.addEventListener('touchend', finish, { passive: true });
  card.addEventListener('touchcancel', finish, { passive: true });
}
