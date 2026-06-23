/**
 * Vault-structure injection for the cached system prompt.
 *
 * Goal: Claude sees the vault's shape from turn 1 so it routes
 * directly to the right folder/note instead of guessing or
 * substring-scanning. Because the map lives in the cached
 * system-prompt prefix and is stable within a session (vault
 * structure doesn't change mid-conversation), it costs ~nothing
 * after the first turn — a cache read, not a re-creation.
 *
 * Pure metadata: derives the folder tree from markdown file paths
 * (app.vault.getMarkdownFiles()). No file reads.
 */

import type { App, TFile } from 'obsidian';

export interface VaultMapOptions {
  /**
   * When the total markdown-note count is <= this threshold, the
   * full note-path list is included so a small vault is fully
   * navigable from context (Claude can read_note directly without
   * any discovery tool). Over the threshold, only the folder tree
   * + counts are emitted. Default 300.
   */
  maxNotesForFullList?: number;
}

/** Hard cap on the rendered map. If the full note list would push
 * past this, fall back to folder-tree-only. ~12KB. */
const MAX_MAP_BYTES = 12_288;

const DEFAULT_FULL_LIST_THRESHOLD = 300;

/**
 * Build the vault-structure section for the system prompt. Returns
 * an empty string when the vault has no markdown notes (nothing to
 * map — callers skip empty sections).
 */
export function buildVaultMap(app: App, opts: VaultMapOptions = {}): string {
  const threshold = opts.maxNotesForFullList ?? DEFAULT_FULL_LIST_THRESHOLD;
  const files = app.vault.getMarkdownFiles();
  const total = files.length;
  if (total === 0) return '';

  const paths = files.map((f: TFile) => f.path).sort((a, b) => a.localeCompare(b));
  const tree = renderFolderTree(paths);

  const header = '## Vault structure';

  // Folder-tree-only rendering (used when over the note threshold or
  // when the full list would blow the size cap).
  const folderOnly = [
    header,
    tree,
    '',
    `(${total} notes total — use list_notes / list_folders / search to drill into folders.)`,
  ].join('\n');

  // Apply the same MAX_MAP_BYTES cap to the folder-tree-only path.
  // An extremely large vault (thousands of deeply-nested folders) can
  // produce a folder tree that exceeds the cap on its own. Truncate to
  // the cap and append a hint so the prompt stays bounded.
  if (total > threshold) {
    if (folderOnly.length <= MAX_MAP_BYTES) return folderOnly;
    return folderOnly.slice(0, MAX_MAP_BYTES) + '\n...(truncated: vault too large to map fully)';
  }

  // Small vault: try to include the full note list.
  const withList = [
    header,
    tree,
    '',
    '## All notes',
    paths.join('\n'),
  ].join('\n');

  if (withList.length <= MAX_MAP_BYTES) return withList;

  // The full list would exceed the size cap — fall back to the
  // folder tree plus a note explaining why the list was elided.
  return [
    header,
    tree,
    '',
    `(${total} notes total — full list elided to bound prompt size; use list_notes / list_folders / search to drill into folders.)`,
  ].join('\n');
}

/**
 * Render a top-level + one-level-deep folder tree with per-folder
 * note counts. Notes at the vault root are grouped under a synthetic
 * "/ (root)" line. Counts are the number of markdown notes directly
 * inside that folder level (top-level counts include nested notes;
 * the indented second level is a subset shown for orientation).
 */
function renderFolderTree(paths: string[]): string {
  // Count notes per top-level folder (everything under "a/..." rolls
  // up to "a/") and per one-level-deep folder ("a/b/...").
  const topCounts = new Map<string, number>();
  const subCounts = new Map<string, number>();
  let rootCount = 0;

  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash < 0) {
      rootCount++;
      continue;
    }
    const top = p.slice(0, slash);
    topCounts.set(top, (topCounts.get(top) ?? 0) + 1);

    const rest = p.slice(slash + 1);
    const slash2 = rest.indexOf('/');
    if (slash2 >= 0) {
      const sub = `${top}/${rest.slice(0, slash2)}`;
      subCounts.set(sub, (subCounts.get(sub) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  if (rootCount > 0) {
    lines.push(`/ (${rootCount} ${plural(rootCount)})`);
  }

  for (const top of [...topCounts.keys()].sort((a, b) => a.localeCompare(b))) {
    const n = topCounts.get(top)!;
    lines.push(`${top}/ (${n} ${plural(n)})`);
    const subs = [...subCounts.keys()]
      .filter((s) => s.startsWith(`${top}/`))
      .sort((a, b) => a.localeCompare(b));
    for (const sub of subs) {
      const sn = subCounts.get(sub)!;
      lines.push(`  ${sub}/ (${sn} ${plural(sn)})`);
    }
  }

  return lines.join('\n');
}

function plural(n: number): string {
  return n === 1 ? 'note' : 'notes';
}
