/**
 * Vault-as-memory shared types (phase 6).
 *
 * Kept in a separate file so the rest of the Worker (and the plugin
 * via the protocol package, where applicable) can import without
 * pulling in the full Workers-AI / Vectorize binding surface.
 */

/**
 * Two kinds of vectors live in the index, separated by Vectorize
 * namespace:
 *   - 'note-summary' — one vector per note, sourced from title +
 *     first paragraph (or a Claude-generated 1-sentence summary).
 *     Default target for find_related — broad topical match.
 *   - 'section' — per-H1/H2 chunks of long notes, ~400 tokens with
 *     50-token overlap. Used for deeper passage queries when the
 *     user asks for specific content.
 */
export type ChunkKind = 'note-summary' | 'section';

export interface VectorMetadata {
  /** Vault-relative path of the source note. */
  path: string;
  /** Human-readable title (Obsidian basename or H1). */
  title?: string;
  /** Heading path for section chunks, e.g. "Intro / Goals". */
  headingPath?: string;
  /** SHA256 of the source content at index time — for staleness checks. */
  sha256?: string;
  /** mtime in ms — secondary staleness signal. */
  mtime?: number;
  //
  // No `excerpt` field by design (phase 6 security review,
  // 2026-05-14): we deliberately don't persist any plaintext vault
  // content in vector metadata. Embeddings themselves are one-way;
  // the path + scoring metadata is the only thing durably stored
  // on the Worker. find_related results render excerpts by
  // re-reading the live vault on the plugin side.
}

export interface SkaldVector {
  id: string;
  kind: ChunkKind;
  vector: number[];
  metadata: VectorMetadata;
}

export interface EmbedDocumentArgs {
  text: string;
  /** Override the default embedding model. */
  model?: string;
}

export interface EmbedQueryArgs extends EmbedDocumentArgs {}

export interface SimilarHit {
  id: string;
  score: number;
  metadata: VectorMetadata | Record<string, unknown>;
}

/**
 * Minimal env shape this module depends on. Picked from the full
 * Worker Env so the memory functions don't pull in the chat path's
 * dependencies (token registry, DO bindings, etc.).
 */
export interface MemoryEnv {
  AI: Ai;
  VECTORIZE: Vectorize;
}
