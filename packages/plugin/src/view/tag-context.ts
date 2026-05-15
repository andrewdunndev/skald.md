import { TFile, type App } from 'obsidian';

const TAG_REGEX = /#([\p{L}\p{N}/_-]+)/gu;

/** Per-tag cap on note paths returned. Mobile contexts don't want
 * 50 paths dumped in — 5 most-recent gives Claude enough to call
 * read_note on the ones that matter. */
const MAX_NOTES_PER_TAG = 5;
const MAX_TAGS = 8;

/**
 * Extract `#tag` mentions from user text. Skips literal `#` followed
 * by non-tag chars (markdown headings, URL fragments). Returns unique
 * tag names without the leading `#`.
 */
export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG_REGEX)) {
    if (tags.size >= MAX_TAGS) break;
    tags.add(m[1]);
  }
  return Array.from(tags);
}

/**
 * Look up vault notes tagged with the given name. Uses Obsidian's
 * metadata cache (tags array + frontmatter tags) so this works
 * without requiring the user to reindex. Sorts by mtime descending
 * (most-recent first) and caps to MAX_NOTES_PER_TAG.
 */
export function notesWithTag(app: App, tag: string): TFile[] {
  const hits: TFile[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const inline = (cache.tags ?? [])
      .map((t) => stripHash(t.tag))
      .includes(tag);
    const fm = cache.frontmatter?.tags;
    const fmHas =
      Array.isArray(fm) && fm.some((t) => stripHash(String(t)) === tag);
    if (inline || fmHas) hits.push(file);
  }
  hits.sort((a, b) => b.stat.mtime - a.stat.mtime);
  return hits.slice(0, MAX_NOTES_PER_TAG);
}

function stripHash(t: string): string {
  return t.startsWith('#') ? t.slice(1) : t;
}

/**
 * Build a `<tag-context>` block to inject alongside the user's
 * `<context>` envelope. Returns null when no tags appear in the
 * text or none of them have matching vault notes — caller skips
 * the wrapper entirely on null.
 *
 * Pure module: takes app for vault access but no view-layer state.
 */
export function buildTagContextBlock(
  app: App,
  text: string,
): string | null {
  const tags = extractTags(text);
  if (tags.length === 0) return null;
  const sections: string[] = [];
  for (const tag of tags) {
    const matches = notesWithTag(app, tag);
    if (matches.length === 0) continue;
    const paths = matches.map((f) => f.path).join(', ');
    sections.push(`  <tag name="#${tag}">${paths}</tag>`);
  }
  if (sections.length === 0) return null;
  return ['<tag-context>', ...sections, '</tag-context>'].join('\n');
}
