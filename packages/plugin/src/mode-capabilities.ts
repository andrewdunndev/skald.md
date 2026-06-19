/**
 * Centralized connection-mode capability descriptor.
 *
 * Every decision that forks on ConnectionMode lives here as a single
 * exhaustive switch. Call sites consume capability fields rather than
 * comparing mode strings directly, so adding a third mode (e.g. 'remote'
 * for the v2 agent-host tier) means: extend ConnectionMode, add a case
 * here, satisfy the compiler — no other file changes required.
 *
 * Resolving an unknown stored mode string (forward-compat downgrade):
 *   resolveConnectionMode(raw) → ConnectionMode, warns once to console.
 *   migrateConnectionMode in settings/connection-mode.ts remains the
 *   upgrade migration; this helper is the runtime guard.
 */
import type { ConnectionMode } from './settings';

/** Exhaustive-switch safety net. TypeScript enforces that every arm of a
 * switch on ConnectionMode is handled; the default can call assertNever to
 * get a compile-time error when a new variant is added without updating the
 * switch. At runtime it throws so the missing case is loud. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled connection mode: ${String(x)}`);
}

export interface ModeCapabilities {
  /**
   * Whether semantic search (find_related via the Worker's Vectorize
   * binding) is available. False in 'direct' mode; true in 'worker'.
   */
  semanticSearch: boolean;
  /**
   * Whether transport construction should use WorkerTransport (true)
   * or DirectTransport (false).
   */
  usesWorker: boolean;
  /**
   * Which banner variant to render.
   * 'worker' → show the "missing URL + token" banner when unconfigured.
   * 'direct' → no banner needed (plugin works immediately).
   */
  banner: 'direct' | 'worker';
}

/** Return the capability descriptor for the given mode. The switch is
 * exhaustive: TypeScript will error if ConnectionMode gains a new value
 * and this function is not updated. */
export function modeCapabilities(mode: ConnectionMode): ModeCapabilities {
  switch (mode) {
    case 'direct':
      return { semanticSearch: false, usesWorker: false, banner: 'direct' };
    case 'worker':
      return { semanticSearch: true, usesWorker: true, banner: 'worker' };
    default:
      return assertNever(mode);
  }
}

/**
 * Resolve a raw stored value (from plugin data.json) to a known
 * ConnectionMode. If the value is already a valid mode, it is returned
 * as-is. If it is an unrecognized non-empty string (a mode stored by a
 * future version that this build doesn't know about), 'direct' is returned
 * as the safe fallback and a single console.warn is emitted — no Notice
 * spam, no silent clobber on save.
 *
 * This is the runtime guard. migrateConnectionMode() in
 * settings/connection-mode.ts handles the initial upgrade heuristic
 * (detecting old Worker-era installs that lacked the field).
 */
export function resolveConnectionMode(raw: unknown): ConnectionMode {
  if (raw === 'direct' || raw === 'worker') return raw;
  if (raw !== undefined && raw !== null && raw !== '') {
    console.warn(
      `skald: unrecognized connectionMode value "${String(raw)}" — ` +
        'falling back to "direct". This value will NOT be overwritten on save.',
    );
  }
  return 'direct';
}
