/**
 * Haptic feedback helper. Wraps navigator.vibrate with feature
 * detection so platforms without the API (desktop, some iOS
 * webviews) silently no-op. Patterns are short — these are
 * confirmation taps, not alerts.
 */

export type HapticIntent = 'approve' | 'reject' | 'select';

const PATTERNS: Record<HapticIntent, number | number[]> = {
  approve: 15, // single short pulse
  reject: [10, 30, 10], // pulse-gap-pulse (more attention)
  select: 8, // softest acknowledgement
};

export function haptic(intent: HapticIntent): void {
  const nav = navigator as { vibrate?: (pattern: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(PATTERNS[intent]);
  } catch {
    // Some browsers throw on disallowed contexts (e.g. iframe). No-op.
  }
}
