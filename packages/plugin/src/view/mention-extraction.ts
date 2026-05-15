/**
 * Extract vault-note paths mentioned in assistant text. Used by the
 * mid-turn write nudge: when Claude SAYS "I'd add this to
 * Bailey/Training.md" but doesn't emit a write tool call, the badge
 * row surfaces a button to propose the write the model named.
 *
 * Detection rules:
 *   1. Bare `.md` paths matching letter/number + slash + dot
 *   2. `[[Wiki Links]]` resolved as `<linktext>.md`
 *
 * False positives are filtered by the caller (which also has the
 * list of paths that DID get written this turn and skips those).
 */

const PATH_REGEX = /\b([A-Za-z0-9_][\w/.-]*?\.md)\b/g;
const WIKI_LINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;

/** Cap on distinct paths surfaced per turn. More than this and the
 * action row turns into a wall of chips. */
const MAX_MENTIONS = 4;

export function extractMentionedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_REGEX)) {
    out.add(m[1]);
    if (out.size >= MAX_MENTIONS) break;
  }
  for (const m of text.matchAll(WIKI_LINK_REGEX)) {
    if (out.size >= MAX_MENTIONS) break;
    const link = m[1].trim();
    // Heuristic: assume vault notes are .md unless the link
    // already names another extension.
    out.add(/\.[a-z0-9]+$/i.test(link) ? link : `${link}.md`);
  }
  return Array.from(out);
}

/**
 * Filter mentioned paths down to those that the assistant talked
 * about but didn't actually write. Caller passes the actual write
 * paths from the same turn (extracted via vault-action-summary).
 */
export function unwrittenMentions(
  mentioned: readonly string[],
  written: readonly string[],
): string[] {
  const writtenSet = new Set(written);
  return mentioned.filter((p) => !writtenSet.has(p));
}
