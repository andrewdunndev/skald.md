import { App, normalizePath, TFile } from 'obsidian';
import type { ToolDefinition } from '@scribian/protocol';

export interface ToolExecutionResult {
  content: string;
  is_error?: boolean;
}

// Anthropic-executed server tools. These are passed in the tools array
// like custom tools, but Anthropic runs them server-side and emits
// server_tool_use + web_search_tool_result / web_fetch_tool_result
// content blocks. The plugin doesn't dispatch them through executeTool.
//
// max_uses bounds runaway cost (web_search is $0.01/search per Anthropic
// pricing; 5 caps a turn at $0.05).
export const SERVER_TOOLS: ToolDefinition[] = [
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  },
  {
    type: 'web_fetch_20250910',
    name: 'web_fetch',
    max_uses: 5,
  },
];

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: 'read_note',
    description:
      'Read the full content of a note in the vault by its vault-relative path. Use this when you need to see what is inside a specific note before answering. Path is vault-relative, e.g. "projects/trip/day-3.md".',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path to the note, e.g. "folder/note.md"',
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
      'Substring-search note contents across the vault. Returns matching note paths with surrounding snippets. Case-insensitive.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text substring to search for',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 20, max 50)',
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

// Convenience: all tool definitions to ship in a chat request. Plugin
// dispatches READ_ONLY_TOOLS via executeTool; SERVER_TOOLS execute on
// Anthropic's side and never reach the executor.
export const ALL_TOOLS: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  ...SERVER_TOOLS,
];

export async function executeTool(
  app: App,
  name: string,
  input: unknown,
): Promise<ToolExecutionResult> {
  const args = (input as Record<string, unknown>) ?? {};
  try {
    switch (name) {
      case 'read_note':
        return await runReadNote(app, args);
      case 'list_notes':
        return runListNotes(app, args);
      case 'search_vault':
        return await runSearchVault(app, args);
      case 'current_note':
        return await runCurrentNote(app);
      case 'metadata':
        return runMetadata(app, args);
      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    return {
      content: err instanceof Error ? err.message : 'tool execution failed',
      is_error: true,
    };
  }
}

function safePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const normalized = normalizePath(raw);
  // Reject anything that resolves outside the vault root.
  if (normalized.includes('..')) return null;
  if (normalized.startsWith('/')) return null;
  return normalized;
}

async function runReadNote(
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
  const content = await app.vault.read(file);
  return { content };
}

function runListNotes(
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
    files.length > limit
      ? `\n\n... and ${files.length - limit} more`
      : '';
  return { content: paths.join('\n') + truncated };
}

async function runSearchVault(
  app: App,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const query =
    typeof args.query === 'string' ? args.query.toLowerCase().trim() : '';
  if (!query) {
    return { content: 'Missing query', is_error: true };
  }
  const requestedLimit =
    typeof args.limit === 'number' ? Math.floor(args.limit) : 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);

  const results: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (results.length >= limit) break;
    const content = await app.vault.cachedRead(file);
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) continue;

    const start = Math.max(0, idx - 60);
    const end = Math.min(content.length, idx + query.length + 60);
    const snippet = content
      .slice(start, end)
      .replace(/\s+/g, ' ')
      .trim();
    results.push(`${file.path}: …${snippet}…`);
  }

  return {
    content: results.length === 0 ? '(no matches)' : results.join('\n'),
  };
}

async function runCurrentNote(app: App): Promise<ToolExecutionResult> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    return { content: '(no active note)' };
  }
  const content = await app.vault.read(file);
  return { content: `Path: ${file.path}\n\n---\n\n${content}` };
}

function runMetadata(
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
