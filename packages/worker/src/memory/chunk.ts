/**
 * Section chunking for vault-as-memory (phase 6 deep).
 *
 * The bge-base-en-v1.5 embedding model caps at 512 input tokens
 * (~2KB markdown). A 5000-word note's note-summary vector — built
 * from title + first 1500 chars — captures the topical match but
 * loses any specific passage further down. Section chunks give us
 * per-H1/H2 vectors so find_related can return the exact section
 * the user means when they say "the part about authentication."
 *
 * Strategy:
 *   - Split on H1 + H2 headings (single # / ## only; H3+ stays in
 *     the parent section to keep chunk count bounded).
 *   - Drop a leading YAML frontmatter block if present.
 *   - Each chunk carries its heading path ("Setup / Auth") so the
 *     search-result excerpt can show where in the note it came from.
 *   - Long sections wrap to bounded slices with a small overlap so a
 *     concept crossing the slice boundary stays embeddable.
 *
 * Vacuity-detection (per principles): the chunker output is asserted
 * by unit tests with concrete inputs and concrete expected outputs —
 * heading paths, slice boundaries, frontmatter stripping. Adding a
 * new chunking branch without a corresponding test will surface as a
 * silently-passing implementation.
 */

export interface SectionChunk {
  /** Heading path: ["Setup", "Auth"] for an H2 "Auth" under H1 "Setup". */
  headingPath: string[];
  /** Chunk text (does NOT include the heading line — that's in
   * headingPath). Already trimmed. */
  content: string;
  /** 0-based index of the chunk within its source note. Used to
   * build a stable Vectorize id when there are multiple chunks per
   * (path, kind). */
  chunkIndex: number;
}

export interface ChunkOpts {
  /** Approximate target size per chunk in characters. Default 1500
   * (~400 bge-base tokens). Sections smaller than this stay
   * intact; sections larger split into windows. */
  targetChars?: number;
  /** Overlap (characters) between adjacent windows of the same
   * section. Keeps concepts crossing the boundary embeddable.
   * Default 200. */
  overlapChars?: number;
}

const DEFAULT_TARGET = 1500;
const DEFAULT_OVERLAP = 200;

/**
 * Split a markdown document into section chunks.
 *
 * If a note has no H1/H2 headings at all, returns a single chunk
 * with an empty headingPath — the caller can decide whether to
 * upsert that as a "section" vector or skip it (note-summary
 * already covers the case).
 */
export function chunkBySection(
  source: string,
  opts: ChunkOpts = {},
): SectionChunk[] {
  const targetChars = opts.targetChars ?? DEFAULT_TARGET;
  const overlapChars = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.max(0, targetChars - 100));

  const body = stripFrontmatter(source);
  const sections = splitSections(body);

  const out: SectionChunk[] = [];
  let chunkIndex = 0;
  for (const section of sections) {
    if (!section.content.trim()) continue;
    const windows = windowText(section.content, targetChars, overlapChars);
    for (const window of windows) {
      out.push({
        headingPath: section.headingPath,
        content: window,
        chunkIndex: chunkIndex++,
      });
    }
  }
  return out;
}

interface RawSection {
  headingPath: string[];
  content: string;
}

/**
 * Walk the document line by line, splitting on H1 + H2 headings.
 * H3+ headings are kept inside the parent section.
 */
function splitSections(body: string): RawSection[] {
  const lines = body.split('\n');
  const sections: RawSection[] = [];
  let currentH1: string | null = null;
  let currentPath: string[] = [];
  let currentLines: string[] = [];

  const flush = () => {
    if (currentLines.length === 0 && currentPath.length === 0) return;
    sections.push({
      headingPath: [...currentPath],
      content: currentLines.join('\n').trim(),
    });
    currentLines = [];
  };

  for (const raw of lines) {
    const h1 = raw.match(/^#\s+(.+?)\s*$/);
    const h2 = raw.match(/^##\s+(.+?)\s*$/);
    if (h1) {
      flush();
      currentH1 = h1[1].trim();
      currentPath = [currentH1];
    } else if (h2) {
      flush();
      currentPath = currentH1 ? [currentH1, h2[1].trim()] : [h2[1].trim()];
    } else {
      currentLines.push(raw);
    }
  }
  flush();
  return sections;
}

/**
 * Split a long section into overlapping windows. Returns the
 * unsliced section when it fits inside `targetChars`. Window
 * boundaries try to land on whitespace so we don't cleave words.
 */
function windowText(
  content: string,
  targetChars: number,
  overlapChars: number,
): string[] {
  const trimmed = content.trim();
  if (trimmed.length <= targetChars) return [trimmed];

  const step = Math.max(targetChars - overlapChars, 1);
  const windows: string[] = [];
  for (let start = 0; start < trimmed.length; start += step) {
    let end = Math.min(start + targetChars, trimmed.length);
    // Try to land on whitespace if we're not at the document end.
    if (end < trimmed.length) {
      const slack = Math.min(80, targetChars - 100);
      const lastSpace = trimmed.lastIndexOf(' ', end);
      if (lastSpace >= end - slack && lastSpace > start) {
        end = lastSpace;
      }
    }
    windows.push(trimmed.slice(start, end).trim());
    if (end >= trimmed.length) break;
  }
  return windows;
}

function stripFrontmatter(s: string): string {
  if (!s.startsWith('---\n')) return s;
  const end = s.indexOf('\n---', 4);
  if (end < 0) return s;
  return s.slice(end + 4).replace(/^\n/, '');
}
