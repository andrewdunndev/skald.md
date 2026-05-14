/**
 * Vault-as-memory scaffolding (phase 6).
 *
 * This module exposes the Worker-side primitives for the
 * memory direction:
 *   - embedDocument / embedQuery — call Workers AI to produce
 *     embedding vectors with the configured model
 *   - upsertChunks / deleteByIds — write to Vectorize
 *   - querySimilar — top-K nearest-neighbor search with namespace
 *     filtering (note-summary vs section)
 *
 * The full DO integration (find_related tool, manifest-diff
 * dispatcher, memory note system-prompt injection, digest cron) lands
 * in subsequent phase 6 sub-phases. This file is the foundation —
 * the bindings exist, the helpers compile, the chat path doesn't yet
 * depend on any of it.
 *
 * Design doc: campaigns/factory/notes/scribian-memory.md (in storr).
 */

import type { ChunkKind, EmbedQueryArgs, EmbedDocumentArgs, MemoryEnv, ScribianVector, SimilarHit } from './types';

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMS = 768;
export const MAX_INPUT_TOKENS = 512;

/**
 * Embed a single document (note section or summary) via Workers AI.
 * Returns a 768-dim vector for cosine similarity in Vectorize.
 *
 * Strings longer than ~2KB will be silently truncated by the model.
 * Caller is responsible for chunking; see the chunking helpers in
 * the scribian-memory design doc.
 */
export async function embedDocument(
  env: MemoryEnv,
  args: EmbedDocumentArgs,
): Promise<number[]> {
  const model = args.model ?? DEFAULT_EMBEDDING_MODEL;
  const resp = (await env.AI.run(model, { text: [args.text] })) as {
    data?: number[][];
  };
  const vec = resp.data?.[0];
  if (!vec || vec.length === 0) {
    throw new Error(`empty embedding from ${model}`);
  }
  return vec;
}

/**
 * Embed a free-text query for similarity search. Same shape as
 * embedDocument; kept as a distinct entry point because queries may
 * later use a different model (asymmetric embedding) — bge-base
 * supports query/passage shared embedding so they're identical
 * today.
 */
export async function embedQuery(
  env: MemoryEnv,
  args: EmbedQueryArgs,
): Promise<number[]> {
  return embedDocument(env, args);
}

/**
 * Upsert one or more vectors into the scribian-vault index. Each
 * vector includes the path, kind (note-summary or section), and
 * metadata for downstream filtering / rendering.
 *
 * Idempotent: same id replaces. Use a stable id derived from
 * `<path>:<kind>:<chunk-ix>` so re-indexing the same content yields
 * the same vector slot.
 */
export async function upsertChunks(
  env: MemoryEnv,
  vectors: ScribianVector[],
): Promise<void> {
  if (vectors.length === 0) return;
  // Vectorize bindings accept the {id, values, metadata, namespace}
  // shape directly. Namespace separates note-summary vs section so
  // queries can target one or the other via the namespace param.
  await env.VECTORIZE.upsert(
    vectors.map((v) => ({
      id: v.id,
      values: v.vector,
      namespace: v.kind,
      metadata: v.metadata as unknown as Record<
        string,
        string | number | boolean
      >,
    })),
  );
}

export async function deleteByIds(
  env: MemoryEnv,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await env.VECTORIZE.deleteByIds(ids);
}

/**
 * Top-K semantic search. Embed the query, query Vectorize for
 * neighbors in the requested namespace (defaults to 'note-summary'
 * for broad topical matches; pass 'section' for deeper passage
 * search).
 */
export async function querySimilar(
  env: MemoryEnv,
  args: {
    query: string;
    kind?: ChunkKind;
    topK?: number;
  },
): Promise<SimilarHit[]> {
  const vec = await embedQuery(env, { text: args.query });
  const namespace = args.kind ?? 'note-summary';
  const topK = Math.min(args.topK ?? 8, 20);
  const result = await env.VECTORIZE.query(vec, {
    topK,
    namespace,
    returnMetadata: 'all',
  });
  return (result.matches ?? []).map((m: any) => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata ?? {},
  }));
}

/**
 * Derive a stable id for a vector slot. Section vectors include a
 * chunk index so a single note can hold multiple section vectors.
 */
export function vectorId(path: string, kind: ChunkKind, chunkIx = 0): string {
  return `${kind}:${path}:${chunkIx}`;
}
