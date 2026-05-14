/**
 * Plugin-side client for the Worker's vault-memory HTTP endpoints
 * (phase 6). The Worker holds the Vectorize + Workers AI bindings;
 * the plugin talks to it over bearer-authenticated HTTP for the
 * memory operations:
 *
 *   POST /index  — upload note content for embedding + upsert
 *   POST /search — query the index, return ranked hits
 *
 * find_related routes through here; the plugin's executeTool
 * forwards `find_related` calls to searchVault().
 */

import { TFile, requestUrl, type App, type RequestUrlParam } from 'obsidian';
import type { ToolExecutionResult } from './tools';

export interface MemoryClientConfig {
  workerUrl: string; // wss:// or https://; we coerce to http(s)
  workerToken: string;
}

export interface SearchHit {
  path: string;
  score: number;
  title?: string;
  excerpt?: string;
}

/**
 * Convert the user's wss:// Worker URL into the matching http(s)
 * base for /index and /search. wss → https, ws → http.
 */
function httpBase(workerUrl: string): string {
  return workerUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

/**
 * Call /search with a free-text query, return ranked hits.
 * Surfaces a clear error message in the tool_result when:
 *  - Worker URL / token aren't configured
 *  - /search is unreachable
 *  - The Vectorize index is empty (user hasn't reindexed yet)
 */
export async function searchVault(
  config: MemoryClientConfig,
  query: string,
  topK: number,
): Promise<SearchHit[]> {
  if (!config.workerUrl || !config.workerToken) {
    throw new Error(
      'find_related requires a configured Worker URL + token in plugin settings.',
    );
  }
  const params: RequestUrlParam = {
    url: `${httpBase(config.workerUrl)}/search`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.workerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, top_k: topK }),
    throw: false,
  };
  const resp = await requestUrl(params);
  if (resp.status >= 400) {
    throw new Error(`/search returned ${resp.status}: ${resp.text.slice(0, 300)}`);
  }
  const body = resp.json as { hits?: SearchHit[] };
  return body.hits ?? [];
}

/**
 * Execute a find_related tool call. Wraps searchVault and formats
 * the response as a tool_result content string. Renders as a small
 * markdown table the plugin's MarkdownRenderer picks up.
 */
export async function executeFindRelated(
  config: MemoryClientConfig,
  input: unknown,
): Promise<ToolExecutionResult> {
  const args = (input as Record<string, unknown>) ?? {};
  const query = typeof args.query === 'string' ? args.query : '';
  const topK = Math.min(
    Math.max(Number(args.top_k ?? 8) | 0, 1),
    20,
  );
  if (!query.trim()) {
    return { content: 'find_related: query is empty.', is_error: true };
  }
  try {
    const hits = await searchVault(config, query, topK);
    if (hits.length === 0) {
      return {
        content:
          'find_related: no related notes found. The vault may not be indexed yet — run the "Scribian: Reindex vault" command and try again.',
      };
    }
    const lines = [
      `Found ${hits.length} related note${hits.length === 1 ? '' : 's'} for query: ${query}`,
      '',
      ...hits.map((h, i) => {
        const title = h.title ?? h.path.replace(/\.md$/, '');
        const score = h.score.toFixed(3);
        const excerpt = h.excerpt ? ` — ${h.excerpt}` : '';
        return `${i + 1}. [[${h.path}|${title}]] (score ${score})${excerpt}`;
      }),
    ];
    return { content: lines.join('\n') };
  } catch (err) {
    return {
      content: `find_related failed: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

/**
 * Walk markdown notes in the vault, batch them, and POST to /index
 * for embedding + upsert. Returns a summary string for the Notice
 * the user sees on the "Reindex vault" command.
 *
 * MVP: full reindex every time. No diff / manifest yet — that lands
 * in a subsequent phase 6 sub-phase. For ~1000 notes this is ~1
 * minute of embedding time and a few cents.
 */
export async function reindexVault(
  app: App,
  config: MemoryClientConfig,
  excludedFolders: string[],
  onProgress: (msg: string) => void,
): Promise<{ indexed: number; skipped: number }> {
  if (!config.workerUrl || !config.workerToken) {
    throw new Error('Worker URL + token must be configured in settings.');
  }
  const files = app.vault.getMarkdownFiles();
  const excluded = excludedFolders
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => f.replace(/\/+$/, '') + '/');

  let indexed = 0;
  let skipped = 0;
  const BATCH_SIZE = 20;
  let batch: { path: string; title: string; content: string }[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const params: RequestUrlParam = {
      url: `${httpBase(config.workerUrl)}/index`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ notes: batch }),
      throw: false,
    };
    const resp = await requestUrl(params);
    if (resp.status >= 400) {
      throw new Error(
        `/index returned ${resp.status}: ${resp.text.slice(0, 300)}`,
      );
    }
    indexed += batch.length;
    onProgress(`Indexed ${indexed} notes…`);
    batch = [];
  };

  for (const f of files) {
    if (!(f instanceof TFile)) continue;
    if (excluded.some((p) => f.path.startsWith(p))) {
      skipped++;
      continue;
    }
    const content = await app.vault.cachedRead(f);
    batch.push({
      path: f.path,
      title: f.basename,
      content: content.slice(0, 4000), // bge-base caps ~2KB; we send a bit more and the Worker truncates
    });
    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
  }
  await flush();

  return { indexed, skipped };
}
