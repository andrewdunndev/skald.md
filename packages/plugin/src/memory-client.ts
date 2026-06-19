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

import {
  normalizePath,
  requestUrl,
  TFile,
  type App,
  type RequestUrlParam,
} from 'obsidian';
import {
  applyDiff,
  diffAgainstManifest,
  type FileInfo,
  type IndexManifest,
} from './index-manifest';
import type { ToolExecutionResult } from './tools';

export interface MemoryClientConfig {
  workerUrl: string; // wss:// or https://; we coerce to http(s)
  workerToken: string;
}

export interface SearchHit {
  path: string;
  score: number;
  title?: string;
  heading_path?: string;
  kind?: 'note-summary' | 'section';
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
 * Execute a find_related tool call. Wraps searchVault, then reads
 * each matched note from the LIVE VAULT to render a short excerpt.
 *
 * Architectural note (phase 6 security review, 2026-05-14):
 * the Worker deliberately does not persist plaintext vault content
 * in vector metadata — embeddings are one-way, paths + scoring meta
 * are the only durable storage. Excerpts come from re-reading the
 * vault here so they're always current AND no plaintext lives on
 * the Worker beyond the moment of embedding.
 */
export async function executeFindRelated(
  app: App,
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
          'find_related: no related notes found. The vault may not be indexed yet — run the "Skald: Reindex vault" command and try again.',
      };
    }
    const lines = [
      `Found ${hits.length} related note${hits.length === 1 ? '' : 's'} for query: ${query}`,
      '',
    ];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const title = h.title ?? h.path.replace(/\.md$/, '');
      const score = h.score.toFixed(3);
      const heading = h.heading_path ? ` › ${h.heading_path}` : '';
      const excerpt = await loadExcerptFromVault(app, h.path);
      const excerptSuffix = excerpt ? ` — ${excerpt}` : '';
      lines.push(
        `${i + 1}. [[${h.path}|${title}]]${heading} (score ${score})${excerptSuffix}`,
      );
    }
    return { content: lines.join('\n') };
  } catch (err) {
    return {
      content: `find_related failed: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

/**
 * Read a note from the vault, strip frontmatter, return a short
 * excerpt for inline rendering in find_related results. Returns the
 * empty string if the note has been deleted since indexing (we
 * surface the path anyway via the search hit; the missing excerpt
 * tells the user the index is stale for that path).
 */
async function loadExcerptFromVault(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) return '';
  try {
    const body = await app.vault.cachedRead(file);
    const stripped = body.startsWith('---\n')
      ? body.replace(/^---\n[\s\S]*?\n---\n?/, '')
      : body;
    const flat = stripped.replace(/\s+/g, ' ').trim();
    return flat.length > 200 ? flat.slice(0, 197) + '…' : flat;
  } catch {
    return '';
  }
}

/**
 * Walk markdown notes in the vault, diff against the stored
 * manifest, ship only the delta to /index. The manifest's mtime +
 * size signal is the change detector; identical-since-last-time
 * notes are skipped, deleted notes are removed from the index,
 * and only added/modified content is re-embedded.
 *
 * For a steady-state 1000-note vault with ~10% monthly edits, a
 * reindex moves from "embed all 1000" to "embed ~3-4 changed +
 * 0-1 deleted" on average — the difference is one Worker call vs.
 * one Worker call per batch of 20 stale entries.
 */
export async function reindexVault(
  app: App,
  config: MemoryClientConfig,
  excludedFolders: string[],
  onProgress: (msg: string) => void,
  loadManifest: () => Promise<IndexManifest>,
  saveManifest: (m: IndexManifest) => Promise<void>,
): Promise<{
  indexed: number;
  skipped: number;
  added: number;
  modified: number;
  deleted: number;
}> {
  if (!config.workerUrl || !config.workerToken) {
    throw new Error('Worker URL + token must be configured in settings.');
  }
  const files = app.vault.getMarkdownFiles();
  const excluded = excludedFolders
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => f.replace(/\/+$/, '') + '/');

  // Build current vault snapshot for the diff. Excluded folders
  // never enter the manifest, so they don't generate spurious
  // "deletions" — the diff routine sees them as if they never
  // existed.
  const current: FileInfo[] = [];
  const indexable: TFile[] = [];
  for (const f of files) {
    if (!(f instanceof TFile)) continue;
    if (excluded.some((p) => f.path.startsWith(p))) continue;
    current.push({ path: f.path, mtime: f.stat.mtime, size: f.stat.size });
    indexable.push(f);
  }

  const manifest = await loadManifest();
  const diff = diffAgainstManifest(current, manifest);
  const skipped = diff.unchanged.length;
  onProgress(
    `Diff: ${diff.added.length} added, ${diff.modified.length} modified, ` +
      `${diff.deleted.length} deleted, ${skipped} unchanged.`,
  );

  if (
    diff.added.length === 0 &&
    diff.modified.length === 0 &&
    diff.deleted.length === 0
  ) {
    return {
      indexed: 0,
      skipped,
      added: 0,
      modified: 0,
      deleted: 0,
    };
  }

  // Map for fast lookup of TFile-by-path during embedding.
  const fileByPath = new Map(indexable.map((f) => [f.path, f]));
  const toIndex = [...diff.added, ...diff.modified];

  let indexed = 0;
  const BATCH_SIZE = 20;
  let batch: { path: string; title: string; content: string }[] = [];

  const flush = async (deletes: string[] = []) => {
    if (batch.length === 0 && deletes.length === 0) return;
    const params: RequestUrlParam = {
      url: `${httpBase(config.workerUrl)}/index`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ notes: batch, deletes }),
      throw: false,
    };
    const resp = await requestUrl(params);
    if (resp.status >= 400) {
      throw new Error(
        `/index returned ${resp.status}: ${resp.text.slice(0, 300)}`,
      );
    }
    indexed += batch.length;
    onProgress(`Indexed ${indexed}/${toIndex.length} notes…`);
    batch = [];
  };

  for (const info of toIndex) {
    const f = fileByPath.get(info.path);
    if (!f) continue;
    const content = await app.vault.cachedRead(f);
    batch.push({
      path: f.path,
      title: f.basename,
      // bge-base caps ~512 tokens (~2KB); the Worker truncates head
      // excerpt + chunks longer sections, so 4KB here gives the
      // chunker enough material.
      content,
    });
    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
  }
  // Final flush ships any leftover batch + the deletes list. The
  // Worker removes note-summary vectors for every deleted path
  // (section vectors orphan; cleaned up on next full reindex).
  await flush(diff.deleted);

  const newManifest = applyDiff(manifest, diff);
  await saveManifest(newManifest);

  return {
    indexed,
    skipped,
    added: diff.added.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length,
  };
}
