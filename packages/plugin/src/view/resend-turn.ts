/**
 * One-tap Resend orchestration for the chat view.
 *
 * Lifted out of view.ts (which is at its LOC cap) so the inline
 * retryable-error Resend affordance has a home without growing the view.
 * Re-dispatches the last user turn via the session and manages composer
 * busy state: lock on start, unlock if there was nothing to resend
 * (otherwise the normal onError/onDone path unlocks it).
 */
import type { ChatSession } from '../chat-session';
import type { Composer } from './composer';
import type { SkaldTransport } from '../transport-interface';

export function resendLastTurn(
  transport: SkaldTransport | null,
  session: ChatSession | null,
  composer: Composer,
): void {
  if (!transport?.isOpen() || !session) return;
  composer.setBusy(true);
  void session.resendLast().then((started) => {
    if (!started) composer.setBusy(false);
  });
}
