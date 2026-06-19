import type { ContentBlock } from '@skald/protocol';

/**
 * Walk a finalized assistant message's content blocks and collect
 * every vault note path Claude read during the turn. Used by the
 * Sources footer to surface tappable [[note]] links under grounded
 * answers.
 *
 * Includes: read_note + metadata → input.path; current_note only
 * when a real path is resolvable (the "(active note)" placeholder is
 * excluded — we have no path to link to).
 *
 * Excludes: search queries (find_related / search_vault), write
 * tools, and anything that isn't a vault read.
 *
 * Returns deduped paths in discovery order. Returns [] when no note
 * paths were found.
 */
export function notesReadInTurn(blocks: readonly ContentBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const b = block as Record<string, any>;
    if (b.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : '';
    const input = (b.input as Record<string, any>) ?? {};
    if (name === 'read_note' || name === 'metadata') {
      if (typeof input.path === 'string') out.push(input.path);
    }
    // current_note has no real path in its input — skip it.
    // find_related / search_vault are queries, not note reads — skip.
  }
  return Array.from(new Set(out));
}

/**
 * Walk an in-flight assistant message's content blocks and collect
 * a compact list of vault sources Claude consulted before the
 * write tool whose id is `currentToolUseId`. Used by the diff card
 * to surface a "Informed by: A.md, B.md, search: 'foo'" line so the
 * user can audit where the proposal's reasoning came from.
 *
 * Walk stops at the matching tool_use so we capture only what
 * informed THIS write (not later ones in a multi-write turn).
 *
 * Sources we surface:
 *   - read_note / metadata → the explicit path
 *   - current_note → "(active note)" (no path in the input)
 *   - find_related / search_vault → "search: <query>" (capped)
 *
 * Returns deduped paths preserving discovery order.
 */
export function readsBeforeToolUse(
  blocks: readonly ContentBlock[],
  currentToolUseId: string,
): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const b = block as Record<string, any>;
    if (b.type === 'tool_use' && b.id === currentToolUseId) break;
    if (b.type !== 'tool_use') continue;
    const name = typeof b.name === 'string' ? b.name : '';
    const input = (b.input as Record<string, any>) ?? {};
    if (name === 'read_note' || name === 'metadata') {
      if (typeof input.path === 'string') out.push(input.path);
    } else if (name === 'current_note') {
      out.push('(active note)');
    } else if (name === 'search_vault') {
      if (typeof input.query === 'string') {
        out.push(`search: "${input.query.slice(0, 40)}"`);
      }
    }
  }
  return Array.from(new Set(out));
}
