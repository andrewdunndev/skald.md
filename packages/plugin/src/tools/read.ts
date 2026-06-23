import { App, TFile } from 'obsidian';
import type { ToolDefinition } from '@skald/protocol';
import { safePath, type ToolExecutionResult } from './context';
import { rerankCandidates } from './rerank';
import { utilityModel as resolveUtilityModel } from '../provider-capabilities';
import type { SkaldSettings } from '../settings';
import { compactToolResult } from '../tool-compact';

// ---------------------------------------------------------------------------
// Omnisearch interop — narrow types; no external @omnisearch package needed.
// ---------------------------------------------------------------------------

interface OmnisearchResult {
  score: number;
  path: string;
  basename: string;
  foundWords: string[];
  excerpt: string;
  matches: { match: string; offset: number }[];
}

interface OmnisearchApi {
  search: (query: string) => Promise<OmnisearchResult[]>;
}

/** Hard cap on most tool results. Above this we truncate + add a footer. */
export const MAX_TOOL_RESULT_BYTES = 4096;

/** Larger cap for read_note — a note body can legitimately be big, but we
 * still cap to avoid runaway token costs. The footer advertises the
 * range-read path. */
export const MAX_NOTE_BYTES = 16384;

/**
 * Truncate a tool result string to `cap` bytes when it exceeds the cap.
 * Appends a human-readable footer so Claude knows it's seeing a partial view
 * and can narrow via limit: N or range args.
 *
 * When `compact` is true, `compactToolResult` runs on the text BEFORE the
 * length check/truncate, so densified content survives the budget (e.g. more
 * table rows fit within the same cap).  Footer/backstop behaviour unchanged.
 */
export function capResult(
  text: string,
  cap: number,
  footer: string,
  compact = false,
): string {
  const working = compact ? compactToolResult(text).text : text;
  if (working.length <= cap) return working;
  const totalKB = Math.round(working.length / 1024);
  return working.slice(0, cap) + `\n\n…truncated (showed first ${cap >= 1024 ? `${Math.round(cap / 1024)}KB` : `${cap}B`} of ${totalKB}KB total — ${footer})`;
}

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: 'read_note',
    description:
      'Read the content of a note in the vault by its vault-relative path. Use outline first to decide whether the full body is needed. For large notes use offset_lines + max_lines to read a specific range and avoid token waste.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path to the note, e.g. "folder/note.md"',
        },
        offset_lines: {
          type: 'number',
          description: 'First line to return (0-indexed). Omit to start from the top.',
        },
        max_lines: {
          type: 'number',
          description: 'Maximum number of lines to return. Omit to return all (capped at ~16KB).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_notes',
    description:
      'List notes in the vault, optionally filtered by a folder. Returns vault-relative paths.',
    input_schema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Optional folder path to filter by. Omit for whole vault.',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 50, max 200)',
        },
      },
    },
  },
  {
    name: 'search_vault',
    description:
      'Search note contents across the ENTIRE vault. Last resort — prefer find_by_tag / find_by_link / search_in_folder to scope first. Returns matching paths with short surrounding snippets. When the Omnisearch plugin is installed, results are BM25-ranked (opportunistic — no install required); otherwise falls back to a case-insensitive substring scan.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text substring to search for',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 8, max 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'current_note',
    description:
      'Get the path and full content of the note currently active in Obsidian. Use this when the user refers to "this note" or "the current note" without specifying a path.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'metadata',
    description:
      'Get frontmatter, tags, and backlinks for a note. Returns JSON. Useful for understanding a note without reading its full content.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path to the note',
        },
      },
      required: ['path'],
    },
  },
];

export async function runReadNote(
  app: App,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const path = safePath(args.path);
  if (!path) {
    return { content: 'Invalid or missing path', is_error: true };
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { content: `Note not found: ${path}`, is_error: true };
  }
  let content = await app.vault.read(file);

  // Optional line-range slicing.
  const hasOffset = typeof args.offset_lines === 'number';
  const hasMax = typeof args.max_lines === 'number';
  if (hasOffset || hasMax) {
    const lines = content.split('\n');
    const offset = hasOffset ? Math.max(0, Math.floor(args.offset_lines as number)) : 0;
    const count = hasMax ? Math.max(1, Math.floor(args.max_lines as number)) : lines.length;
    content = lines.slice(offset, offset + count).join('\n');
  }

  return { content: capResult(content, MAX_NOTE_BYTES, 'call again with offset_lines + max_lines to read a specific range') };
}

export function runListNotes(
  app: App,
  args: Record<string, unknown>,
): ToolExecutionResult {
  const folder =
    typeof args.folder === 'string' && args.folder.length > 0
      ? safePath(args.folder)
      : null;
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 50;
  const limit = Math.min(Math.max(requestedLimit, 1), 200);

  let files = app.vault.getMarkdownFiles();
  if (folder) {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    files = files.filter(
      (f) => f.path === folder || f.path.startsWith(prefix),
    );
  }

  const paths = files.slice(0, limit).map((f) => f.path);
  if (paths.length === 0) {
    return { content: '(no notes found)' };
  }
  const truncated =
    files.length > limit ? `\n\n... and ${files.length - limit} more` : '';
  const raw = paths.join('\n') + truncated;
  return { content: capResult(raw, MAX_TOOL_RESULT_BYTES, 'call with a smaller limit or a folder filter to drill down') };
}

export async function runSearchVault(
  app: App,
  args: Record<string, unknown>,
  anthropicApiKey?: string,
  provider?: import('@skald/protocol').Provider,
  settings?: SkaldSettings,
): Promise<ToolExecutionResult> {
  const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
  if (!rawQuery) {
    return { content: 'Missing query', is_error: true };
  }
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 8;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);

  // The reranker uses the active provider's utility model. Gate only on
  // whether a key for the active provider is available; rerank now works
  // on any provider via the shared utilityComplete helper.
  // Absent provider defaults to 'anthropic' (back-compat).
  const resolvedProvider = provider ?? 'anthropic';
  const utilityKey =
    resolvedProvider === 'openrouter'
      ? (settings?.openrouterApiKey ?? '')
      : resolvedProvider === 'openai'
        ? (settings?.openaiApiKey ?? '')
        : (settings?.anthropicApiKey ?? anthropicApiKey ?? '');
  const utilityBaseUrl =
    resolvedProvider === 'openai' ? (settings?.openaiBaseUrl ?? '') : undefined;
  // OpenAI-compatible endpoints may need no key; gate rerank on a key for
  // the key-requiring providers, and on a base URL for openai.
  const canRerank =
    resolvedProvider === 'openai' ? !!utilityBaseUrl : !!utilityKey;
  // Model for the utility reranker — respects settings.utilityModel override.
  const rerankModel = settings
    ? resolveUtilityModel(settings)
    : 'claude-haiku-4-5';

  // ---------------------------------------------------------------------------
  // Omnisearch fast path — BM25-ranked results when the plugin is present.
  // Access via app.plugins is preferred (App is already in scope); fall through
  // to the globalThis surface as a secondary probe so tests can mock either.
  // ---------------------------------------------------------------------------
  const omnisearchApi: OmnisearchApi | undefined =
    (
      app as unknown as {
        plugins?: { plugins?: Record<string, { api?: OmnisearchApi }> };
      }
    ).plugins?.plugins?.['omnisearch']?.api ??
    (globalThis as unknown as { omnisearch?: OmnisearchApi }).omnisearch;

  if (omnisearchApi?.search) {
    try {
      const hits = await omnisearchApi.search(rawQuery);
      const top = hits.slice(0, limit);
      if (top.length > 0) {
        let lines = top.map(
          (r) => `${r.path}: …${r.excerpt.replace(/\s+/g, ' ').trim()}…`,
        );
        let header = '(via omnisearch: ranked)';
        if (lines.length > 5 && canRerank) {
          const reranked = await rerankCandidates(rawQuery, lines, resolvedProvider, utilityKey, { baseUrl: utilityBaseUrl }, rerankModel);
          lines = reranked;
          header = '(reranked by haiku)';
        }
        const raw = `${header}\n${lines.join('\n')}`;
        return {
          content: capResult(
            raw,
            MAX_TOOL_RESULT_BYTES,
            'call with limit:N or use search_in_folder to drill down',
          ),
        };
      }
      // Zero hits from Omnisearch — fall through to substring scan so the user
      // isn't left empty-handed if the index is stale.
    } catch {
      // Omnisearch threw; fall through silently.
    }
  }

  // ---------------------------------------------------------------------------
  // Substring scan fallback.
  // ---------------------------------------------------------------------------
  const query = rawQuery.toLowerCase();
  const results: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (results.length >= limit) break;
    const content = await app.vault.cachedRead(file);
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) continue;

    const start = Math.max(0, idx - 30);
    const end = Math.min(content.length, idx + query.length + 30);
    const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
    results.push(`${file.path}: …${snippet}…`);
  }

  if (results.length === 0) {
    return { content: '(no matches)' };
  }

  let finalResults = results;
  let scanHeader = '';
  if (results.length > 5 && canRerank) {
    finalResults = await rerankCandidates(rawQuery, results, resolvedProvider, utilityKey, { baseUrl: utilityBaseUrl }, rerankModel);
    scanHeader = '(reranked by utility model)\n';
  }

  const raw = scanHeader + finalResults.join('\n');
  return {
    content: capResult(raw, MAX_TOOL_RESULT_BYTES, 'call with limit:N or use search_in_folder to drill down'),
  };
}

export async function runCurrentNote(app: App): Promise<ToolExecutionResult> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    return { content: '(no active note)' };
  }
  const content = await app.vault.read(file);
  return { content: `Path: ${file.path}\n\n---\n\n${content}` };
}

export function runMetadata(
  app: App,
  args: Record<string, unknown>,
): ToolExecutionResult {
  const path = safePath(args.path);
  if (!path) {
    return { content: 'Invalid or missing path', is_error: true };
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { content: `Note not found: ${path}`, is_error: true };
  }
  const cache = app.metadataCache.getFileCache(file);
  const out: Record<string, unknown> = { path: file.path };
  if (cache?.frontmatter) out.frontmatter = cache.frontmatter;
  if (cache?.tags && cache.tags.length > 0) {
    out.tags = cache.tags.map((t) => t.tag);
  }
  if (cache?.headings && cache.headings.length > 0) {
    out.headings = cache.headings.map((h) => ({
      level: h.level,
      text: h.heading,
    }));
  }
  // Backlinks via the (typed-as-any) helper
  const mc = app.metadataCache as unknown as {
    getBacklinksForFile?: (f: TFile) => { data?: Record<string, unknown> };
  };
  const backlinks = mc.getBacklinksForFile?.(file);
  if (backlinks?.data) {
    out.backlinks = Object.keys(backlinks.data);
  }
  return { content: JSON.stringify(out, null, 2) };
}
