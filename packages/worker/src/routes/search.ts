import type { Env, MemoryEnv } from '../env';
import { TokenRegistry } from '../auth';
import { querySimilar } from '../memory';
import type { ChunkKind } from '../memory/types';
import { authMemoryRoute } from './index';

interface SearchRequestBody {
  query?: string;
  top_k?: number;
  /** Which Vectorize namespace to query. Defaults to 'note-summary'
   * for the broad topical match. 'section' for deep passage search;
   * 'both' returns mixed results (note-summary preferred on ties). */
  kind?: 'note-summary' | 'section' | 'both';
}

/**
 * POST /search — embed a free-text query, return top-K nearest
 * note-summary neighbors with similarity scores.
 */
export async function handleSearchRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
): Promise<Response> {
  const memEnv = authMemoryRoute(req, env, registry);
  if ('error' in memEnv) return memEnv.error;
  try {
    return await handleSearch(req, memEnv.env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal error';
    return new Response(msg, { status: 500 });
  }
}

async function handleSearch(req: Request, env: MemoryEnv): Promise<Response> {
  const body = (await req.json()) as SearchRequestBody;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return new Response('expected { query: "..." }', { status: 400 });
  }
  const topK = Math.min(Math.max(Number(body.top_k ?? 8), 1), 20);
  const kind = body.kind ?? 'note-summary';
  const kinds: ChunkKind[] =
    kind === 'both' ? ['note-summary', 'section'] : [kind];

  const allHits: Array<
    Awaited<ReturnType<typeof querySimilar>>[number] & { kind: ChunkKind }
  > = [];
  for (const k of kinds) {
    const hits = await querySimilar(env, { query, kind: k, topK });
    for (const h of hits) allHits.push({ ...h, kind: k });
  }
  // Merge: prefer higher scores; on near-ties, note-summary wins
  // because the broad match is usually what the user wants.
  allHits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.kind === b.kind) return 0;
    return a.kind === 'note-summary' ? -1 : 1;
  });
  const trimmed = allHits.slice(0, topK);

  return Response.json({
    hits: trimmed.map((h) => {
      const meta = h.metadata as Record<string, unknown>;
      return {
        path: typeof meta.path === 'string' ? meta.path : h.id,
        title:
          typeof meta.title === 'string'
            ? meta.title
            : typeof meta.path === 'string'
              ? meta.path
              : h.id,
        // No excerpt here by design — the Worker doesn't persist
        // plaintext vault content (phase 6 security review). The
        // plugin reads excerpts from the live vault when rendering
        // find_related results.
        heading_path:
          typeof meta.headingPath === 'string' ? meta.headingPath : undefined,
        kind: h.kind,
        score: h.score,
      };
    }),
  });
}
