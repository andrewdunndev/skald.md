import { App } from 'obsidian';
import type { ToolDefinition } from '@skald/protocol';
import { type ApproveFn, type ToolExecutionResult } from './context';
import { runAppendToNote, runEditNote } from './write';

/**
 * Explicit memory tools. Each routes to the existing diff-card-
 * gated write helpers with the configured memory path injected
 * — the model never specifies a path. Same approval surface as
 * write_note / edit_note / append_to_note.
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
        search: { type: 'string', description: 'Exact substring in the memory note to replace.' },
        replace: { type: 'string', description: 'Replacement text.' },
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
        fact: { type: 'string', description: 'Exact text of the fact to remove from memory.' },
      },
      required: ['fact'],
    },
  },
];

const NO_PATH = (tool: string): ToolExecutionResult => ({
  content: `${tool}: memory path not configured. Set Memory note path in plugin settings.`,
  is_error: true,
});

export async function runRememberFact(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
  memoryPath: string | undefined,
): Promise<ToolExecutionResult> {
  if (!memoryPath) return NO_PATH('remember_fact');
  const fact = typeof args.fact === 'string' ? args.fact : '';
  if (!fact.trim()) return { content: 'remember_fact: empty fact rejected.', is_error: true };
  return runAppendToNote(app, { path: memoryPath, content: fact }, toolUseId, approve);
}

export async function runUpdateMemory(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
  memoryPath: string | undefined,
): Promise<ToolExecutionResult> {
  if (!memoryPath) return NO_PATH('update_memory');
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

export async function runForgetFact(
  app: App,
  args: Record<string, unknown>,
  toolUseId: string,
  approve: ApproveFn,
  memoryPath: string | undefined,
): Promise<ToolExecutionResult> {
  if (!memoryPath) return NO_PATH('forget_fact');
  const fact = typeof args.fact === 'string' ? args.fact : '';
  if (!fact.trim()) return { content: 'forget_fact: empty fact rejected.', is_error: true };
  return runEditNote(app, { path: memoryPath, search: fact, replace: '' }, toolUseId, approve);
}
