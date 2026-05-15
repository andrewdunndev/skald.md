import type { ContentBlock } from '@scribian/protocol';

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
    } else if (name === 'find_related' || name === 'search_vault') {
      if (typeof input.query === 'string') {
        out.push(`search: "${input.query.slice(0, 40)}"`);
      }
    }
  }
  return Array.from(new Set(out));
}
