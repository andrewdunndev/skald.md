/**
 * Human-readable label for a tool_use — a single-line summary that fits in the
 * collapsed tool-call row. Raw JSON args never appear to non-developers.
 *
 * Extracted from block-renderer.ts (which was at the 400-line cap) as a pure,
 * self-contained helper.
 */
export function describeToolUse(name: string, input: unknown): string {
  const i = (input as Record<string, any>) ?? {};
  switch (name) {
    case 'read_note':
      return `📖 Reading ${i.path ?? '?'}`;
    case 'list_notes': {
      const where = i.folder ? ` in \`${i.folder}\`` : '';
      const limit = i.limit ? ` (limit ${i.limit})` : '';
      return `📋 Listing notes${where}${limit}`;
    }
    case 'search_vault':
      return `🔍 Searching vault for "${i.query ?? '?'}"`;
    case 'current_note':
      return `📍 Reading the current note`;
    case 'metadata':
      return `ℹ️ Metadata for ${i.path ?? '?'}`;
    case 'web_search':
      return `🌐 Web search: "${i.query ?? '?'}"`;
    case 'web_fetch':
      return `🌐 Fetching ${i.url ?? '?'}`;
    case 'write_note':
      return `✏️ Write ${i.path ?? '?'}`;
    case 'edit_note':
      return `✏️ Edit ${i.path ?? '?'}`;
    case 'append_to_note':
      return `➕ Append to ${i.path ?? '?'}`;
    default:
      return `🔧 ${name}`;
  }
}
