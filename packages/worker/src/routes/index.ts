import type { Env, MemoryEnv } from '../env';
import { TokenRegistry, hasScope } from '../auth';
import { embedDocument, upsertChunks, vectorId } from '../memory';
import { chunkBySection } from '../memory/chunk';
import type { SkaldVector } from '../memory/types';
import { authBearer } from './auth-helpers';

/** DOS-resistance caps. An authenticated client could otherwise
 * ship a multi-MB body to drain Workers AI compute (embeddings are
 * billed per call + per byte). These caps are well above realistic
 * vault sizes — a 50KB markdown note is already an outlier; 200
 * notes/batch keeps reindex of even a 10k-note vault under 50
 * batches. Reject early with a clear error so the plugin can
 * adjust if it ever needs more. */
export const INDEX_MAX_NOTES_PER_BATCH = 200;
export const INDEX_MAX_CONTENT_BYTES = 50 * 1024;
export const INDEX_MAX_DELETES_PER_BATCH = 500;

interface IndexRequestBody {
  notes?: Array<{ path?: string; title?: string; content?: string }>;
  /** Vault-relative paths whose vectors should be removed. The
   * Worker computes the note-summary ID for each (a known shape:
   * `note-summary:${path}:0`) and calls deleteByIds. Section
   * vectors for the same path orphan in this v1; next full reindex
   * with manifest rebuild will cull them. */
  deletes?: string[];
}

/**
 * POST /index — embed + upsert a batch of notes. Each note produces:
 *   - one 'note-summary' vector (title + first ~1500 chars) for the
 *     broad topical match,
 *   - optionally per-H1/H2 'section' vectors when the note has
 *     explicit heading structure AND is long enough to justify
 *     splitting. Short headerless notes are covered by note-summary
 *     alone, no duplication.
 *
 * Returns { indexed_summaries, indexed_sections } so the plugin's
 * progress UI can show what landed.
 */
export async function handleIndexRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
): Promise<Response> {
  const memEnv = authMemoryRoute(req, env, registry);
  if ('error' in memEnv) return memEnv.error;
  try {
    return await handleIndex(req, memEnv.env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal error';
    return new Response(msg, { status: 500 });
  }
}

/**
 * Shared gating for memory-backed routes (/index + /search). Returns
 * either a narrowed env with AI + VECTORIZE confirmed present, or an
 * error Response the caller forwards verbatim.
 */
export function authMemoryRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
): { env: MemoryEnv } | { error: Response } {
  const auth = authBearer(req, registry);
  if (!auth.ok) {
    return { error: new Response(auth.reason, { status: auth.status }) };
  }
  if (!hasScope(auth.result.scopes, 'chat')) {
    return { error: new Response('token lacks chat scope', { status: 403 }) };
  }
  if (!env.AI || !env.VECTORIZE) {
    return {
      error: new Response(
        'vault-memory bindings not configured on this Worker',
        { status: 503 },
      ),
    };
  }
  if (req.method !== 'POST') {
    return {
      error: new Response('method not allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      }),
    };
  }
  return { env: { AI: env.AI, VECTORIZE: env.VECTORIZE } };
}

async function handleIndex(req: Request, env: MemoryEnv): Promise<Response> {
  const body = (await req.json()) as IndexRequestBody;
  if (!Array.isArray(body.notes)) {
    return new Response('expected { notes: [...] }', { status: 400 });
  }
  if (body.notes.length > INDEX_MAX_NOTES_PER_BATCH) {
    return new Response(
      `too many notes in batch (${body.notes.length} > ${INDEX_MAX_NOTES_PER_BATCH}); split into smaller batches`,
      { status: 413 },
    );
  }
  if (
    Array.isArray(body.deletes) &&
    body.deletes.length > INDEX_MAX_DELETES_PER_BATCH
  ) {
    return new Response(
      `too many deletes in batch (${body.deletes.length} > ${INDEX_MAX_DELETES_PER_BATCH})`,
      { status: 413 },
    );
  }
  const vectors: SkaldVector[] = [];
  let indexedSummaries = 0;
  let indexedSections = 0;
  let skippedOversize = 0;
  for (const n of body.notes) {
    const path = typeof n.path === 'string' ? n.path : '';
    const title = typeof n.title === 'string' ? n.title : path;
    const content = typeof n.content === 'string' ? n.content : '';
    if (!path || !content.trim()) continue;
    // Per-note content cap: skip outsize notes rather than failing
    // the whole batch (the plugin's reindex shouldn't choke on one
    // huge note; it should still process the rest + report).
    if (byteLength(content) > INDEX_MAX_CONTENT_BYTES) {
      skippedOversize++;
      continue;
    }

    // 1. note-summary vector: always emitted. Title + head excerpt.
    const headExcerpt = content.slice(0, 1500);
    const sha = await sha256Hex(content);
    const summaryVec = await embedDocument(env, {
      text: `${title}\n\n${headExcerpt}`,
    });
    vectors.push({
      id: vectorId(path, 'note-summary', 0),
      kind: 'note-summary',
      vector: summaryVec,
      metadata: {
        path,
        title,
        sha256: sha,
        mtime: Date.now(),
      },
    });
    indexedSummaries++;

    // 2. section vectors: only when the note has H1/H2 structure
    //    AND is long enough that note-summary doesn't already cover
    //    it. Short headerless notes get note-summary alone.
    if (content.length < 1000) continue;
    const sections = chunkBySection(content);
    const hasRealHeadings = sections.some((s) => s.headingPath.length > 0);
    if (!hasRealHeadings) continue;
    for (const sec of sections) {
      if (sec.headingPath.length === 0) continue; // skip the
      // before-first-heading preamble; it's already in note-summary.
      const vec = await embedDocument(env, { text: sec.content });
      vectors.push({
        id: vectorId(path, 'section', sec.chunkIndex),
        kind: 'section',
        vector: vec,
        metadata: {
          path,
          title,
          headingPath: sec.headingPath.join(' / '),
          sha256: sha,
          mtime: Date.now(),
        },
      });
      indexedSections++;
    }
  }
  await upsertChunks(env, vectors);

  // Process deletes: remove the note-summary vector for each path
  // the plugin reported as removed-since-last-index. Section
  // vectors orphan; they'll be culled when the user runs a full
  // reindex (a future enhancement: track per-path section counts
  // in the manifest so deletes can be exact).
  let deleted = 0;
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  if (deletes.length > 0) {
    const ids = deletes
      .filter((p): p is string => typeof p === 'string' && !!p)
      .map((p) => vectorId(p, 'note-summary', 0));
    await env.VECTORIZE.deleteByIds(ids);
    deleted = ids.length;
  }

  return Response.json({
    indexed: indexedSummaries, // back-compat for plugin's existing parse
    indexed_summaries: indexedSummaries,
    indexed_sections: indexedSections,
    deleted,
    skipped_oversize: skippedOversize,
  });
}

/**
 * SHA-256 hex via WebCrypto. Workers AI input cap means the
 * embedded text is truncated; the sha256 here is over the original
 * full content so the plugin's future manifest-diff can detect
 * changes accurately.
 */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** UTF-8 byte length — measures the actual wire/embedding cost,
 * not JS string length (which is UTF-16 code units). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
