/**
 * Timeout constants and signal-composition helper for DirectTransport.
 *
 * Extracted so direct-transport.ts stays under the 400-line cap and
 * these helpers are independently unit-testable.
 */

/** Abort the initial fetch if no response arrives within this window. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Abort a stalled stream if no chunk arrives within this window. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Return an AbortSignal that fires when EITHER the caller-supplied signal
 * fires OR the given timeout elapses — whichever comes first.
 *
 * Uses AbortSignal.any() where available (modern environments) and falls
 * back to a manual listener approach for environments that lack it.
 */
export function composeSignal(outer: AbortSignal, ms: number): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  // AbortSignal.any is available in Node 20+ / Chrome 116+ / Firefox 124+.
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outer, timer]);
  }
  // Fallback: manual fan-in.
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (outer.aborted) { ac.abort(); return ac.signal; }
  if (timer.aborted) { ac.abort(); return ac.signal; }
  outer.addEventListener('abort', abort, { once: true });
  timer.addEventListener('abort', abort, { once: true });
  return ac.signal;
}
