import { App, TFile } from 'obsidian';
import type { ToolDefinition } from '@scribian/protocol';
import {
  safePath,
  type ApproveFn,
  type ToolExecutionResult,
  type WriteKind,
} from './context';

/**
 * Explicit memory tools. Tools the model can call when it learns
 * something worth persisting across chats. Each routes to the
 * existing diff-card-gated write helpers with the configured memory
 * path injected — the model never specifies a path. Approval is
 * identical to write_note/edit_note/append_to_note: a diff card
 * appears, user clicks approve/reject.
 */
export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: 'remember_fact',
    description:
      "Append a fact to the user's long-term memory note. Use this when the user explicitly tells you to remember something, OR when you observe a stable fact about the user (preference, important name, recurring context) that will help future chats. The user reviews + approves the addition via a diff card before it lands in the vault.",
    input_schema: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'The fact to remember. One sentence is ideal. Prefer concrete and time-stable facts ("Bailey is allergic to chicken") over ephemeral observations ("user is busy today").',
        },
      },
      required: ['fact'],
    },
  },
  {
    name: 'update_memory',
    description:
      "Edit an existing fact in the user's long-term memory note. Replaces the exact substring `search` with `replace`. The substring must appear exactly once. Use this when a remembered fact changes (preference shifts, name spelling correction, etc.). User approves via diff card.",
    input_schema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Exact substring in the memory note to replace.',
        },
        replace: {
          type: 'string',
          description: 'Replacement text.',
        },
      },
      required: ['search', 'replace'],
    },
  },
  {
    name: 'forget_fact',
    description:
      "Remove a fact from the user's long-term memory note. Use this when the user explicitly tells you to forget something, OR when the fact is no longer accurate. The fact substring must appear exactly once. User approves via diff card.",
    input_schema: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description: 'Exact text of the fact to remove from memory.',
        },
      },
      required: ['fact'],
    },
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

export async function runWriteNote(
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

export async function runEditNote(
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

export async function runAppendToNote(
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

/**
 * remember_fact dispatch — append the fact to the configured memory
 * note. Delegates to runAppendToNote with the memory path injected.
 * memoryPath is required (the model shouldn't pick the path); absent
 * memoryPath → clear configuration error.
 */
export async function runRememberFact(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
  memoryPath: string | undefined,
): Promise<ToolExecutionResult> {
  if (!memoryPath) {
    return {
      content:
        'remember_fact: memory path not configured. Set Memory note path in plugin settings.',
      is_error: true,
    };
  }
  const fact = typeof args.fact === 'string' ? args.fact : '';
  if (!fact.trim()) {
    return { content: 'remember_fact: empty fact rejected.', is_error: true };
  }
  return runAppendToNote(
    app,
    { path: memoryPath, content: fact },
    toolUseId,
    approve,
  );
}

/**
 * update_memory dispatch — edit a fact in the memory note. Delegates
 * to runEditNote with the memory path injected.
 */
export async function runUpdateMemory(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
  memoryPath: string | undefined,
): Promise<ToolExecutionResult> {
  if (!memoryPath) {
    return {
      content:
        'update_memory: memory path not configured. Set Memory note path in plugin settings.',
      is_error: true,
    };
  }
  return runEditNote(
    app,
    {
      path: memoryPath,
      search: typeof args.search === 'string' ? args.search : '',
      replace: typeof args.replace === 'string' ? args.replace : '',
    },
    toolUseId,
    approve,
  );
}

/**
 * forget_fact dispatch — remove a fact from the memory note.
 * Delegates to runEditNote with the memory path injected and an
 * empty replacement string.
 */
export async function runForgetFact(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
  memoryPath: string | undefined,
): Promise<ToolExecutionResult> {
  if (!memoryPath) {
    return {
      content:
        'forget_fact: memory path not configured. Set Memory note path in plugin settings.',
      is_error: true,
    };
  }
  const fact = typeof args.fact === 'string' ? args.fact : '';
  if (!fact.trim()) {
    return { content: 'forget_fact: empty fact rejected.', is_error: true };
  }
  return runEditNote(
    app,
    { path: memoryPath, search: fact, replace: '' },
    toolUseId,
    approve,
  );
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
