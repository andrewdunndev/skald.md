import { App, TFile, type TAbstractFile } from 'obsidian';
import type { ToolDefinition } from '@skald/protocol';
import {
  INVALID_WRITE_PATH,
  safeNotePath,
  type ApproveFn,
  type ToolExecutionResult,
  type WriteKind,
} from './context';

// MEMORY_TOOLS + memory runners live in ./memory.ts so this file
// stays focused on the canonical write-tool surface.

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

export async function runWriteNote(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
): Promise<ToolExecutionResult> {
  const path = safeNotePath(args.path);
  if (!path) return { content: INVALID_WRITE_PATH, is_error: true };
  const content = typeof args.content === 'string' ? args.content : '';

  const existing = app.vault.getAbstractFileByPath(path);
  const unwritable = await unindexedTarget(app, path, existing);
  if (unwritable) return unwritable;
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
    // TOCTOU guard: re-read inside vault.process so we compare against the
    // actual on-disk content at the moment of write. If the file changed
    // after the diff card was shown — another editor pane, sync, etc. —
    // abort with a clear error rather than silently discarding those edits.
    // `before` is the snapshot that was shown to the user in the diff card.
    const beforeSnapshot = before; // captured above before the approve call
    let changed = false;
    try {
      await app.vault.process(existing, (current) => {
        if (current !== beforeSnapshot) {
          changed = true;
          // Return current unchanged — vault.process requires a string return.
          return current;
        }
        return content;
      });
    } catch (err) {
      return {
        content: `Write to ${path} failed: ${err instanceof Error ? err.message : 'unknown error'}. Re-read and re-propose.`,
        is_error: true,
      };
    }
    if (changed) {
      return {
        content: `Write to ${path} aborted — note changed since the diff was shown. Re-read the note and re-propose.`,
        is_error: true,
      };
    }
    return { content: `Overwrote ${path} (${content.length} chars).` };
  }
  await ensureFolderFor(app, path);
  await app.vault.create(path, content);
  return { content: `Created ${path} (${content.length} chars).` };
}

export async function runEditNote(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
): Promise<ToolExecutionResult> {
  const path = safeNotePath(args.path);
  if (!path) return { content: INVALID_WRITE_PATH, is_error: true };
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
  // vault.process applies the transform atomically against the
  // current on-disk content — safer than read-then-modify when the
  // target file is open in another editor pane with unsaved edits.
  // If the search string moved out from under us between approval
  // and apply (rare but possible on shared/synced vaults), the
  // process callback throws and we surface a clear error rather
  // than silently writing stale content.
  try {
    await app.vault.process(file, (current) => {
      if (!current.includes(search)) {
        throw new Error('search string no longer present');
      }
      return current.replace(search, replace);
    });
  } catch (err) {
    return {
      content: `Edit to ${path} failed: ${err instanceof Error ? err.message : 'unknown error'}. Re-read the file and try again.`,
      is_error: true,
    };
  }
  return {
    content: `Edited ${path}: replaced ${search.length}-char block.`,
  };
}

export async function runAppendToNote(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
): Promise<ToolExecutionResult> {
  const path = safeNotePath(args.path);
  if (!path) return { content: INVALID_WRITE_PATH, is_error: true };
  const content = typeof args.content === 'string' ? args.content : '';

  const existing = app.vault.getAbstractFileByPath(path);
  const unwritable = await unindexedTarget(app, path, existing);
  if (unwritable) return unwritable;
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
    // process atomically appends against the current on-disk
    // content. Re-derives the separator from THAT content (not
    // the snapshot we read earlier) so concurrent edits don't
    // produce double-blank-lines or run-on paragraphs.
    await app.vault.process(existing, (current) => {
      const sep = current.endsWith('\n') ? '\n' : '\n\n';
      return current + sep + content;
    });
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

/**
 * A write labels itself `create` only when nothing is at the path. A
 * folder there, or a file on disk the vault index doesn't know about
 * (a case-only name clash, an external write not yet indexed), would
 * make that label a lie, so refuse instead.
 */
async function unindexedTarget(
  app: App,
  path: string,
  existing: TAbstractFile | null,
): Promise<ToolExecutionResult | null> {
  if (existing instanceof TFile) return null;
  if (existing || (await app.vault.adapter.exists(path))) {
    return {
      content: `Cannot write ${path}: something already exists there that is not a note in the vault index.`,
      is_error: true,
    };
  }
  return null;
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
