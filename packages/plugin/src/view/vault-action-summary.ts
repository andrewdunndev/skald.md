/**
 * Per-turn summary of what hit (or didn't hit) the vault. Surfaces
 * below the assistant message so the user can scan "did Claude do
 * the thing" without expanding tool cards.
 *
 * The vault-action-default in the system prompt tells Claude to
 * propose a vault write as the closing move on most turns. The badge
 * is the visible signal of that contract working — or not. When it
 * reads "no vault action," the user knows to ask "where should this
 * land?" as a follow-up.
 */

import type { ContentBlock, Message } from '@skald/protocol';

const READ_TOOLS = new Set([
  'read_note',
  'current_note',
  'metadata',
  'list_notes',
]);

const SEARCH_TOOLS = new Set(['search_vault', 'find_related']);

const WRITE_TOOLS = new Set([
  'write_note',
  'edit_note',
  'append_to_note',
  'remember_fact',
  'update_memory',
  'forget_fact',
]);

export interface VaultActionSummary {
  reads: number;
  searches: number;
  /** Successful write paths (excludes rejected / errored). */
  writes: string[];
  /** Write attempts that the user (or the system) rejected — count
   * only, paths omitted to keep the badge terse. Surfaced separately
   * so users see "Claude tried but you rejected" distinct from
   * "Claude didn't try." */
  rejectedWrites: number;
}

/** Walk an assistant message's content blocks and tally vault tool
 * activity. Reads are counted by tool_use; writes are counted only
 * when the matching tool_result returned non-error. Pure — no
 * side effects, fully testable. */
export function summarizeVaultActions(msg: Message): VaultActionSummary {
  const summary: VaultActionSummary = {
    reads: 0,
    searches: 0,
    writes: [],
    rejectedWrites: 0,
  };
  if (typeof msg.content === 'string') return summary;

  // First pass: tool_use blocks (the intent) keyed by id so the
  // second pass (tool_result) can decide success vs rejection.
  const writeIntents = new Map<string, { path: string }>();
  for (const block of msg.content as ContentBlock[]) {
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : '';
    if (READ_TOOLS.has(name)) {
      summary.reads += 1;
    } else if (SEARCH_TOOLS.has(name)) {
      summary.searches += 1;
    } else if (WRITE_TOOLS.has(name)) {
      const id = typeof b.id === 'string' ? b.id : '';
      const path = extractWritePath(name, b.input);
      writeIntents.set(id, { path });
    }
  }

  // Second pass: tool_result blocks match writes by tool_use_id.
  // Absent result = pending or aborted; we don't count it.
  for (const block of msg.content as ContentBlock[]) {
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
    const intent = writeIntents.get(id);
    if (!intent) continue;
    if (b.is_error) {
      summary.rejectedWrites += 1;
    } else {
      summary.writes.push(intent.path || '(unnamed)');
    }
    writeIntents.delete(id);
  }

  // Writes whose tool_result never landed in this message (e.g. the
  // stream cut off mid-turn) stay invisible — we don't claim success
  // or rejection for an unresolved intent.

  return summary;
}

/**
 * Derive the most user-meaningful path from a write tool's input.
 * remember_fact/update_memory/forget_fact don't carry a path
 * directly — they route via the configured memory path — so we
 * surface a synthetic "memory" label for them. The user always
 * knows the actual path via their memory settings; the badge is
 * about "what category of action," not full audit detail.
 */
function extractWritePath(name: string, input: unknown): string {
  if (
    name === 'remember_fact' ||
    name === 'update_memory' ||
    name === 'forget_fact'
  ) {
    return 'memory';
  }
  const args = (input as Record<string, unknown>) ?? {};
  return typeof args.path === 'string' ? args.path : '';
}

/**
 * Compact display string for the badge. Empty when there's nothing
 * to surface (the host omits the badge entirely on empty turns —
 * see the "no vault action" branch in the renderer).
 */
export function formatSummary(s: VaultActionSummary): string {
  const parts: string[] = [];
  if (s.reads > 0) parts.push(`📖 read ${s.reads}`);
  if (s.searches > 0) parts.push(`🔍 searched ${s.searches}`);
  if (s.writes.length > 0) {
    const paths = uniquePaths(s.writes);
    const label = paths.length === 1 ? paths[0] : `${s.writes.length} notes`;
    parts.push(`✏️ wrote ${label}`);
  }
  if (s.rejectedWrites > 0) {
    parts.push(`↩️ rejected ${s.rejectedWrites}`);
  }
  return parts.join(' · ');
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/**
 * Should we render the badge at all? True when any vault action
 * happened OR when a write was rejected; false when the turn was
 * pure text/thinking with no tool activity. The "no vault action"
 * label is rendered separately by the host to emphasize the prompt
 * vs answer.
 */
export function hasAnyAction(s: VaultActionSummary): boolean {
  return (
    s.reads > 0 ||
    s.searches > 0 ||
    s.writes.length > 0 ||
    s.rejectedWrites > 0
  );
}
