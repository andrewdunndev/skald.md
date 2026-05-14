import { App, normalizePath, TFile } from 'obsidian';
import type { ToolDefinition } from '@scribian/protocol';
import { executeFindRelated, type MemoryClientConfig } from './memory-client';

export interface ToolExecutionResult {
  content: string;
  is_error?: boolean;
}

export type WriteKind = 'create' | 'overwrite' | 'edit' | 'append';

export interface WriteProposal {
  toolUseId: string;
  kind: WriteKind;
  path: string;
  before: string | null;
  after: string;
}

export type ApproveFn = (proposal: WriteProposal) => Promise<boolean>;

/**
 * Context every tool executor receives. Required fields are the
 * foundation (Vault API + approval flow); optional fields gate
 * specific tools (memoryClient for find_related). This keeps the
 * executor a single dispatch point with no special-cases at the
 * call site.
 */
export interface ToolContext {
  app: App;
  approve: ApproveFn;
  /** Phase 6: enables find_related. Absent → tool returns a clear
   * "not configured" error. */
  memoryClient?: MemoryClientConfig;
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

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'write_note',
    description:
      'Create a new note or fully overwrite an existing one. The user must approve the write via a diff card before it commits to the vault — never assume the write happened. If the note exists, the call replaces its entire content.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path, e.g. "research/walkable-areas-indy.md". Folders are created automatically.',
        },
        content: {
          type: 'string',
          description: 'Full markdown body of the note.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_note',
    description:
      "Replace a substring in an existing note. The substring must match exactly (whitespace, casing, line breaks) and appear exactly once. The user approves the edit via diff card before commit. Use this for surgical changes; use write_note for whole-note replacement.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path' },
        search: {
          type: 'string',
          description: 'Exact substring to replace. Must appear exactly once in the file.',
        },
        replace: {
          type: 'string',
          description: 'Replacement text. Use empty string to delete the matched substring.',
        },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'append_to_note',
    description:
      'Append content to the end of an existing note (or create it if missing). User approves via diff card. Good for journals, todos, append-only logs.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path' },
        content: {
          type: 'string',
          description: 'Markdown content to append. A blank line is inserted between the existing content and the new content.',
        },
      },
      required: ['path', 'content'],
    },
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
  {
    name: 'find_related',
    description:
      'Find vault notes semantically related to a free-text query. Returns ranked matches with vault-relative paths, similarity scores, and short excerpts. Use this when the user asks about a topic and you want to surface related notes the user might not remember exists. Requires the user to have indexed their vault at least once via the "Scribian: Reindex vault" command.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query. E.g. "knitting projects", "advice on resume writing".',
        },
        top_k: {
          type: 'number',
          description: 'Max results (default 8, max 20).',
        },
      },
      required: ['query'],
    },
  },
];

// Convenience: all tool definitions to ship in a chat request. Plugin
// dispatches READ_ONLY_TOOLS + WRITE_TOOLS via executeTool; SERVER_TOOLS
// execute on Anthropic's side and never reach the executor.
export const ALL_TOOLS: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS,
  ...SERVER_TOOLS,
];

export async function executeTool(
  name: string,
  input: unknown,
  toolUseId: string,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const args = (input as Record<string, unknown>) ?? {};
  try {
    switch (name) {
      case 'read_note':
        return await runReadNote(ctx.app, args);
      case 'list_notes':
        return runListNotes(ctx.app, args);
      case 'search_vault':
        return await runSearchVault(ctx.app, args);
      case 'current_note':
        return await runCurrentNote(ctx.app);
      case 'metadata':
        return runMetadata(ctx.app, args);
      case 'write_note':
        return await runWriteNote(ctx.app, args, toolUseId, ctx.approve);
      case 'edit_note':
        return await runEditNote(ctx.app, args, toolUseId, ctx.approve);
      case 'append_to_note':
        return await runAppendToNote(ctx.app, args, toolUseId, ctx.approve);
      case 'find_related':
        if (!ctx.memoryClient) {
          return {
            content:
              'find_related: memory client not configured. Set the Worker URL + token in plugin settings.',
            is_error: true,
          };
        }
        return await executeFindRelated(ctx.memoryClient, input);
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

// ─── Write tools (paused via approval) ─────────────────────────────

async function runWriteNote(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
): Promise<ToolExecutionResult> {
  const path = safePath(args.path);
  if (!path) {
    return { content: 'Invalid or missing path', is_error: true };
  }
  const content = typeof args.content === 'string' ? args.content : '';

  const existing = app.vault.getAbstractFileByPath(path);
  let before: string | null = null;
  let kind: WriteKind = 'create';
  if (existing instanceof TFile) {
    before = await app.vault.read(existing);
    kind = 'overwrite';
  }

  const approved = await approve({
    toolUseId,
    kind,
    path,
    before,
    after: content,
  });
  if (!approved) {
    return {
      content: `User rejected the write to ${path}. No changes were made.`,
      is_error: true,
    };
  }

  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return { content: `Overwrote ${path} (${content.length} chars).` };
  }
  await ensureFolderFor(app, path);
  await app.vault.create(path, content);
  return { content: `Created ${path} (${content.length} chars).` };
}

async function runEditNote(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
): Promise<ToolExecutionResult> {
  const path = safePath(args.path);
  if (!path) return { content: 'Invalid or missing path', is_error: true };
  const search = typeof args.search === 'string' ? args.search : '';
  const replace = typeof args.replace === 'string' ? args.replace : '';
  if (!search) {
    return { content: 'Missing search string', is_error: true };
  }
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    return { content: `Note not found: ${path}`, is_error: true };
  }

  const before = await app.vault.read(file);
  const occurrences = countOccurrences(before, search);
  if (occurrences === 0) {
    return {
      content: `Search string not found in ${path}. The file may have changed; read it again before editing.`,
      is_error: true,
    };
  }
  if (occurrences > 1) {
    return {
      content: `Search string occurs ${occurrences} times in ${path}. Provide more context so it matches exactly once.`,
      is_error: true,
    };
  }
  const after = before.replace(search, replace);

  const approved = await approve({
    toolUseId,
    kind: 'edit',
    path,
    before,
    after,
  });
  if (!approved) {
    return {
      content: `User rejected the edit to ${path}. No changes were made.`,
      is_error: true,
    };
  }
  await app.vault.modify(file, after);
  return {
    content: `Edited ${path}: replaced ${search.length}-char block.`,
  };
}

async function runAppendToNote(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
): Promise<ToolExecutionResult> {
  const path = safePath(args.path);
  if (!path) return { content: 'Invalid or missing path', is_error: true };
  const content = typeof args.content === 'string' ? args.content : '';

  const existing = app.vault.getAbstractFileByPath(path);
  let before: string | null = null;
  let after: string;
  let kind: WriteKind = 'append';
  if (existing instanceof TFile) {
    before = await app.vault.read(existing);
    const sep = before.endsWith('\n') ? '\n' : '\n\n';
    after = before + sep + content;
  } else {
    after = content;
    kind = 'create';
  }

  const approved = await approve({
    toolUseId,
    kind,
    path,
    before,
    after,
  });
  if (!approved) {
    return {
      content: `User rejected the append to ${path}. No changes were made.`,
      is_error: true,
    };
  }
  if (existing instanceof TFile) {
    await app.vault.modify(existing, after);
    return {
      content: `Appended ${content.length} chars to ${path}.`,
    };
  }
  await ensureFolderFor(app, path);
  await app.vault.create(path, after);
  return {
    content: `Created ${path} with ${content.length} chars.`,
  };
}

async function ensureFolderFor(app: App, vaultPath: string): Promise<void> {
  const idx = vaultPath.lastIndexOf('/');
  if (idx <= 0) return;
  const folder = vaultPath.slice(0, idx);
  if (app.vault.getAbstractFileByPath(folder)) return;
  await app.vault.createFolder(folder);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
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
