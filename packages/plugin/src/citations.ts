/**
 * Anthropic Citations API — request shaping and response parsing.
 *
 * When `providerCapabilities(provider).citations` is true, vault notes
 * returned by read_note are additionally surfaced as `document` content
 * blocks (type='document', source.type='text') in the same user turn
 * that carries the tool_result. Anthropic's Citations feature then
 * returns `text` blocks whose `citations` array points back to specific
 * character ranges in the source document.
 *
 * WHY document blocks alongside tool_result?
 * The Anthropic Citations API requires document blocks to appear in
 * user-turn content. A tool_result message IS a user turn, so we append
 * document blocks to the same content array. The tool_result carries the
 * short path echo (for tool-call book-keeping); the document block
 * carries the full note body (for citation grounding).
 *
 * No beta header required — citations are GA as of the 2023-06-01 API.
 *
 * Streaming: the assistant streams `citations_delta` events alongside
 * `text_delta`. ChatSession.handleChunk accumulates them onto the block's
 * `citations` array. The renderer then surfaces them as superscript
 * markers.
 *
 * Non-Anthropic path: the gate in chat-session.ts checks
 * `providerCapabilities(provider).citations` before shaping document
 * blocks. When false the existing plain-text tool_result path is used
 * unchanged and the Sources footer continues to be the grounding story.
 */

export interface CitationLocation {
  type: 'char_location' | 'page_location' | 'content_block_location';
  cited_text: string;
  document_index: number;
  document_title: string | null;
  /** char_location */
  start_char_index?: number;
  end_char_index?: number;
  /** page_location */
  start_page_number?: number;
  end_page_number?: number;
  /** content_block_location */
  start_block_index?: number;
  end_block_index?: number;
}

/**
 * A document content block that carries `citations: { enabled: true }`.
 * Placed in the user turn alongside the corresponding tool_result.
 * The `title` is the vault-relative path so the rendered citation
 * marker can link back to the source note.
 *
 * Deliberately carries NO cache_control: document blocks are per-request
 * grounding context, not cross-turn cache candidates. The cache breakpoint
 * budget (system + last-tool + moving-history = 3 of Anthropic's 4) is
 * already spoken for in anthropic-caching.ts; adding cache_control here
 * could push a multi-document turn past 4 breakpoints → 400.
 */
export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'text';
    media_type: 'text/plain';
    data: string;
  };
  title: string;
  citations: { enabled: true };
}

/**
 * Build a document block from a note read result.
 *
 * @param path    - Vault-relative path; becomes the block's title so
 *                  citation markers can link back to it.
 * @param body    - Full note body (the content field from read_note).
 */
export function buildDocumentBlock(path: string, body: string): DocumentBlock {
  return {
    type: 'document',
    source: {
      type: 'text',
      media_type: 'text/plain',
      data: body,
    },
    title: path,
    citations: { enabled: true },
  };
}

/**
 * Parse a citation location from the streaming `citations_delta`
 * payload. Returns null on any shape mismatch so callers can soft-fail.
 */
export function parseCitationLocation(
  raw: unknown,
): CitationLocation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (
    type !== 'char_location' &&
    type !== 'page_location' &&
    type !== 'content_block_location'
  ) {
    return null;
  }
  return raw as CitationLocation;
}

/**
 * Render a compact inline citation marker for use in the rendered
 * message DOM. Returns a string like `[1]` (1-indexed by discovery
 * order in the response). The caller maps document_index to a path
 * using the document registry built during the turn.
 */
export function citationLabel(documentIndex: number): string {
  return `[${documentIndex + 1}]`;
}

/**
 * Extract the vault path for a citation from a document registry.
 * The registry maps document_index → vault path (the `title` field
 * on the document block).
 */
export function citationPath(
  registry: ReadonlyMap<number, string>,
  citation: CitationLocation,
): string | null {
  return registry.get(citation.document_index) ?? null;
}
