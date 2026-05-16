/**
 * Generic sliding-window rate limiter. Used by the capture
 * protocol handler to bound the rate at which a hostile webpage
 * can fire `obsidian://scribian-capture` URLs (each capture costs
 * LLM tokens).
 *
 * Pure: timestamps live in-memory on the instance, no persistence,
 * resets on plugin reload. The reset behavior is the right
 * granularity — a fresh session is implicitly trusted.
 */
export class SlidingWindow {
  private timestamps: number[] = [];

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
  ) {}

  /** True when accepting one more event would exceed the cap.
   * Prunes expired timestamps in-place before the decision so
   * callers don't need to maintain the window. */
  isExceeded(now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    return this.timestamps.length >= this.maxEvents;
  }

  /** Record an accepted event. Caller checks isExceeded first;
   * record only after the action is committed. */
  record(now: number = Date.now()): void {
    this.timestamps.push(now);
  }

  /** Current count in the live window. Surfaced for the rate-
   * limit Notice so users see the burst size. */
  size(): number {
    return this.timestamps.length;
  }
}
