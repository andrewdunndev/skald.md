/**
 * Screen-reader live region for streamed assistant replies.
 *
 * Why a dedicated element instead of aria-live on the messages
 * container: the in-flight assistant row is re-emptied and
 * re-rendered on every streaming delta (see message-list.ts
 * flushRender → renderRow, which calls row.body.empty() per tick).
 * Putting aria-live on that thrash-prone subtree floods the screen
 * reader's queue — every 150ms throttle tick would re-announce the
 * whole partial message. Assistive tech can't keep up and the user
 * hears a stutter of overlapping partials.
 *
 * Instead we mount one visually-hidden polite region (role="log",
 * aria-relevant="additions text") and push ONLY finalized assistant
 * text into it once per completed turn. role="log" tells the screen
 * reader this is an append-only event stream; aria-live="polite"
 * waits for a pause before announcing so it never interrupts the
 * user. The region is off-screen (.skald-sr-only) so it never
 * affects layout.
 */
import type { Message } from '../protocol';

/**
 * Pure decision: the text that should be announced for a finalized
 * assistant turn, or '' when there's nothing speakable (tool-only /
 * image-only / empty turn). Concatenates visible text blocks; skips
 * thinking blocks, tool calls, and images — matching what the user
 * sees rendered. Exported for unit-testing the announce path without
 * a DOM.
 */
export function announceableText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content.trim();
  const parts: string[] = [];
  for (const block of msg.content) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n\n').trim();
}

export class LiveRegion {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: 'skald-sr-only' });
    this.el.setAttrs({
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-atomic': 'false',
      role: 'log',
    });
  }

  /**
   * Announce a finalized chunk of text. Appended as a child node so
   * aria-relevant="additions" fires a fresh announcement; empty /
   * whitespace-only input is ignored so we never queue a blank
   * utterance.
   */
  announce(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.el.createDiv({ text: trimmed });
  }

  /** Drop queued announcements — used on new chat / disconnect so a
   * stale partial doesn't get read after the pane is cleared. */
  clear(): void {
    this.el.empty();
  }
}
