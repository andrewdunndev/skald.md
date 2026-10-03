/**
 * Graph-aware metadataCache tools. All five tools query Obsidian's in-memory
 * metadataCache (links, backlinks, tags, frontmatter, headings) — zero file
 * I/O, mobile-safe, sub-millisecond on typical vaults. Returns are tiny
 * structured strings (paths + counts, not bodies) so token cost is minimal.
 *
 * Strategy: Claude calls these to NARROW the candidate set, then reads only
 * 2–3 actual notes with read_note. This replaces the broad search_vault
 * scan as the default first reach.
 */

import { App, TFile, TFolder } from 'obsidian';
import type { ToolDefinition } from '../protocol';
import type { ToolExecutionResult } from './context';
import { safePath } from './context';
import { notesWithTag } from '../view/tag-context';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const GRAPH_TOOLS: ToolDefinition[] = [
  {
    name: 'list_folders',
    description:
      'List the top-level folders in the vault. Use this when a query mentions a person, project, or topic that may have its own folder (e.g. "Garden", "taxes", "work"). Call list_folders first, check for a matching folder, then use list_notes with that folder to narrow cheaply. Much cheaper than substring-searching the whole vault.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_by_tag',
    description:
      'Find vault notes that have ALL of the given tags (intersection). Use this BEFORE read_note when the user mentions a topic you might have tagged notes about. Returns vault-relative paths, most-recent first. Far cheaper than search_vault — no file reads.',
    input_schema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tag names to intersect. Omit the leading # — e.g. ["project", "active"].',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20, max 100).',
        },
      },
      required: ['tags'],
    },
  },
  {
    name: 'find_by_link',
    description:
      'Find notes linked to or from a given note. Use this to explore the local neighbourhood of a note without reading file content. Returns vault-relative paths.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path of the target note.',
        },
        direction: {
          type: 'string',
          enum: ['in', 'out', 'both'],
          description:
            '"in" = backlinks (notes that link to this note); "out" = outgoing links from this note; "both" = union (default).',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20, max 100).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'recent_notes',
    description:
      'List vault notes sorted by modification time, newest first. Optionally scoped to a folder. Use this when the user asks about "what I was working on" or "my latest notes". Pure metadata — no file reads.',
    input_schema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description:
            'Optional vault-relative folder to scope the search. Omit for whole vault.',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20, max 100).',
        },
      },
    },
  },
  {
    name: 'outline',
    description:
      'Get the heading tree, link count, and tag count for a note. Use this BEFORE read_note to decide whether the full body is worth reading — it is much cheaper. Returns headings with level and text, plus link/tag counts.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path to the note.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_in_folder',
    description:
      'Substring-search note contents scoped to a single folder. Much cheaper than search_vault on large vaults because it only scans one subtree. Case-insensitive.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text substring to search for.',
        },
        folder: {
          type: 'string',
          description: 'Vault-relative folder path to restrict the search.',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 8, max 50).',
        },
      },
      required: ['query', 'folder'],
    },
  },
];

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

function stripHash(t: string): string {
  return t.startsWith('#') ? t.slice(1) : t;
}

export function runFindByTag(
  app: App,
  args: Record<string, unknown>,
): ToolExecutionResult {
  const raw = args.tags;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { content: 'tags must be a non-empty array', is_error: true };
  }
  const tags = raw.map((t) => stripHash(String(t)));
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  // Intersect: start with all files matching the first tag, then filter.
  // notesWithTag applies its own MAX_NOTES_PER_TAG cap, so we call the
  // cache directly for the full intersection pass.
  const files = app.vault.getMarkdownFiles();
  const hits: TFile[] = [];

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;

    const inlineTags = (cache.tags ?? []).map((t) => stripHash(t.tag));
    const fmTags = Array.isArray(cache.frontmatter?.tags)
      ? (cache.frontmatter.tags as unknown[]).map((t) => stripHash(String(t)))
      : [];
    const allTags = new Set([...inlineTags, ...fmTags]);

    if (tags.every((tag) => allTags.has(tag))) {
      hits.push(file);
    }
  }

  hits.sort((a, b) => b.stat.mtime - a.stat.mtime);
  const sliced = hits.slice(0, limit);

  if (sliced.length === 0) {
    return { content: `(no notes tagged with all of: ${tags.join(', ')})` };
  }
  const more =
    hits.length > limit ? `\n\n… and ${hits.length - limit} more` : '';
  return { content: sliced.map((f) => f.path).join('\n') + more };
}

export function runFindByLink(
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

  const direction =
    typeof args.direction === 'string' &&
    (args.direction === 'in' || args.direction === 'out')
      ? args.direction
      : 'both';
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const results = new Set<string>();

  if (direction === 'out' || direction === 'both') {
    const outLinks = app.metadataCache.resolvedLinks[path] ?? {};
    for (const outPath of Object.keys(outLinks)) {
      results.add(outPath);
    }
  }

  if (direction === 'in' || direction === 'both') {
    const mc = app.metadataCache as unknown as {
      getBacklinksForFile?: (f: TFile) => { data?: Record<string, unknown> };
    };
    const backlinks = mc.getBacklinksForFile?.(file);
    if (backlinks?.data) {
      for (const inPath of Object.keys(backlinks.data)) {
        results.add(inPath);
      }
    }
  }

  const paths = Array.from(results).slice(0, limit);
  if (paths.length === 0) {
    return {
      content: `(no ${direction === 'both' ? '' : direction + '-'}links found for ${path})`,
    };
  }
  const more =
    results.size > limit ? `\n\n… and ${results.size - limit} more` : '';
  return { content: paths.join('\n') + more };
}

export function runRecentNotes(
  app: App,
  args: Record<string, unknown>,
): ToolExecutionResult {
  const folder =
    typeof args.folder === 'string' && args.folder.length > 0
      ? safePath(args.folder)
      : null;
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  let files = app.vault.getMarkdownFiles();
  if (folder) {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    files = files.filter(
      (f) => f.path === folder || f.path.startsWith(prefix),
    );
  }

  files.sort((a, b) => b.stat.mtime - a.stat.mtime);
  const sliced = files.slice(0, limit);

  if (sliced.length === 0) {
    return { content: '(no notes found)' };
  }
  const more =
    files.length > limit ? `\n\n… and ${files.length - limit} more` : '';
  return { content: sliced.map((f) => f.path).join('\n') + more };
}

export function runOutline(
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
  const lines: string[] = [`path: ${path}`];

  if (cache?.headings && cache.headings.length > 0) {
    lines.push('headings:');
    for (const h of cache.headings) {
      lines.push(`  ${'#'.repeat(h.level)} ${h.heading}`);
    }
  } else {
    lines.push('headings: (none)');
  }

  const linkCount = Object.keys(
    app.metadataCache.resolvedLinks[path] ?? {},
  ).length;
  const tagCount = (cache?.tags ?? []).length;
  const fmTags = Array.isArray(cache?.frontmatter?.tags)
    ? (cache.frontmatter.tags as unknown[]).length
    : 0;

  lines.push(`links: ${linkCount}`);
  lines.push(`tags: ${tagCount + fmTags}`);

  return { content: lines.join('\n') };
}

export async function runSearchInFolder(
  app: App,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const query =
    typeof args.query === 'string' ? args.query.toLowerCase().trim() : '';
  if (!query) {
    return { content: 'Missing query', is_error: true };
  }
  const folder = safePath(args.folder);
  if (!folder) {
    return { content: 'Invalid or missing folder', is_error: true };
  }
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 8;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);

  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  const files = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path === folder || f.path.startsWith(prefix));

  const results: string[] = [];
  for (const file of files) {
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

  return {
    content: results.length === 0 ? '(no matches)' : results.join('\n'),
  };
}

export function runListFolders(app: App): ToolExecutionResult {
  const items = app.vault.getAllLoadedFiles();
  const folders: string[] = [];
  for (const item of items) {
    if (item instanceof TFolder && item.path !== '/') {
      // Only top-level folders: no slash in path (or a single root slash).
      if (!item.path.includes('/')) {
        folders.push(item.path);
      }
    }
  }
  folders.sort();
  if (folders.length === 0) {
    return { content: '(no top-level folders found)' };
  }
  const capped = folders.slice(0, 100);
  const more = folders.length > 100 ? `\n… and ${folders.length - 100} more` : '';
  return { content: capped.join('\n') + more };
}

// Re-export for convenience in tests
export { notesWithTag };
