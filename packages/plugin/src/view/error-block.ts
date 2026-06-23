/**
 * Inline transcript renderer for a failed turn (skald_error block).
 *
 * A failed turn (bad key / network / provider overload) is surfaced as
 * a synthetic block in the transcript — not only in the status row —
 * so the user sees it where they are looking. When the transport judged
 * the error retryable (429 / 5xx / network / mid-stream provider error),
 * a one-tap Resend re-dispatches the last user turn (still in history).
 *
 * Kept in its own module so block-renderer.ts and message-list.ts stay
 * under the LOC cap; the block-renderer dispatches here on type.
 */
import { setIcon } from 'obsidian';

export interface ErrorBlockContext {
  /** Re-send the last user turn. Wired to the inline Resend button;
   * absent (or non-retryable) → no button is rendered. */
  onResend?: () => void;
}

/** Render a skald_error block: an alert row with the message and, when
 * retryable, a Resend button. Returns nothing; paints into `parent`. */
export function renderErrorBlock(
  parent: HTMLElement,
  block: Record<string, unknown>,
  ctx: ErrorBlockContext,
): void {
  const text = typeof block.text === 'string' ? block.text : 'The request failed.';
  const retryable = block.retryable === true;

  const card = parent.createDiv({ cls: 'skald-error-block' });
  // role=alert so AT announces the failure when it appears.
  card.setAttr('role', 'alert');

  const head = card.createDiv({ cls: 'skald-error-head' });
  const icon = head.createSpan({ cls: 'skald-error-icon' });
  icon.setAttr('aria-hidden', 'true');
  setIcon(icon, 'alert-circle');
  head.createSpan({ cls: 'skald-error-text', text });

  if (retryable && ctx.onResend) {
    const btn = card.createEl('button', {
      cls: 'skald-error-resend',
      text: 'Resend',
      attr: { 'aria-label': 'Resend the last message' },
    });
    const reicon = btn.createSpan({ cls: 'skald-error-resend-icon' });
    reicon.setAttr('aria-hidden', 'true');
    setIcon(reicon, 'rotate-cw');
    btn.addEventListener('click', () => ctx.onResend?.());
  }
}
