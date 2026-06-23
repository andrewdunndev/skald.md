import type { ToolDefinition } from '@skald/protocol';
import type { ToolContext, ToolExecutionResult } from './context';
import {
  READ_ONLY_TOOLS,
  runReadNote,
  runListNotes,
  runSearchVault,
  runCurrentNote,
  runMetadata,
} from './read';
import {
  GRAPH_TOOLS,
  runFindByTag,
  runFindByLink,
  runRecentNotes,
  runOutline,
  runSearchInFolder,
  runListFolders,
} from './graph';
import {
  WRITE_TOOLS,
  runWriteNote,
  runEditNote,
  runAppendToNote,
} from './write';
import {
  MEMORY_TOOLS,
  runRememberFact,
  runUpdateMemory,
  runForgetFact,
} from './memory';
import { SERVER_TOOLS, serverToolsForModel } from './server';

export type {
  ApproveFn,
  ToolContext,
  ToolExecutionResult,
  WriteKind,
  WriteProposal,
} from './context';
export { READ_ONLY_TOOLS, GRAPH_TOOLS, WRITE_TOOLS, MEMORY_TOOLS, SERVER_TOOLS, serverToolsForModel };

/** Set of tool names safe to execute concurrently (read-only vault
 * operations — no write, no approval flow). Built once at module load. */
const READ_ONLY_NAMES: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS.map((t) => (t as Record<string, unknown>).name as string),
  ...GRAPH_TOOLS.map((t) => (t as Record<string, unknown>).name as string),
]);

/**
 * Returns true when the named tool is read-only (safe to parallelise).
 * Write tools (write_note, edit_note, append_to_note) and memory tools
 * (remember_fact, update_memory, forget_fact) return false — those carry
 * an approval flow and must run strictly one at a time.
 */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_NAMES.has(name);
}

/**
 * Every tool definition shipped on a chat request. Plugin dispatches
 * READ_ONLY_TOOLS + WRITE_TOOLS + MEMORY_TOOLS through executeTool;
 * SERVER_TOOLS execute on the provider side and never reach the
 * executor.
 *
 * Prefer `buildActiveTools()` for live chat sessions — it gates the
 * memory tools on settings so Claude doesn't see tools that would
 * error at execution. ALL_TOOLS stays for tests + callers that
 * need the full catalog.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  ...GRAPH_TOOLS,
  ...WRITE_TOOLS,
  ...MEMORY_TOOLS,
  ...SERVER_TOOLS,
];

export interface ActiveToolInput {
  /** Whether memory-prompt injection is enabled. When false, the
   * memory tools (remember_fact / update_memory / forget_fact)
   * are filtered out — they require a configured memory path and
   * surfacing them would invite Claude to call tools that return
   * "memory path not configured" errors. */
  memoryEnabled: boolean;
  /** Vault-relative path of the memory note. Empty disables the
   * memory tools even if memoryEnabled is true. */
  memoryPath: string;
  /**
   * The model id for the current turn. Used to select the correct
   * server-tool version pins — Haiku needs 20250305/20250910 while
   * all other Anthropic models use 20260209. Defaults to the
   * 20260209 set when absent (backward compatibility).
   */
  model?: string;
}

/**
 * Build the per-turn tool catalog for a chat session. Filters
 * tools whose preconditions aren't met given the current settings,
 * so Claude only sees tools it can actually use successfully.
 */
export function buildActiveTools(input: ActiveToolInput): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    ...READ_ONLY_TOOLS,
    ...GRAPH_TOOLS,
    ...WRITE_TOOLS,
  ];
  if (input.memoryEnabled && input.memoryPath.trim()) {
    tools.push(...MEMORY_TOOLS);
  }
  // Server tools (web_search / web_fetch) execute on the provider side.
  // Use the model-appropriate version pins so Haiku doesn't 400.
  tools.push(...serverToolsForModel(input.model ?? ''));
  return tools;
}

export async function executeTool(
  name: string,
  input: unknown,
  toolUseId: string,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const args = (input as Record<string, unknown>) ?? {};
  try {
    const compact = ctx.compactToolResults ?? true;
    switch (name) {
      case 'read_note':
        return await runReadNote(ctx.app, args, compact);
      case 'list_notes':
        return runListNotes(ctx.app, args, compact);
      case 'search_vault':
        return await runSearchVault(
          ctx.app,
          args,
          ctx.anthropicApiKey,
          ctx.provider,
          undefined,
          compact,
        );
      case 'current_note':
        return await runCurrentNote(ctx.app);
      case 'metadata':
        return runMetadata(ctx.app, args);
      case 'list_folders':
        return runListFolders(ctx.app);
      case 'find_by_tag':
        return runFindByTag(ctx.app, args);
      case 'find_by_link':
        return runFindByLink(ctx.app, args);
      case 'recent_notes':
        return runRecentNotes(ctx.app, args);
      case 'outline':
        return runOutline(ctx.app, args);
      case 'search_in_folder':
        return await runSearchInFolder(ctx.app, args);
      case 'write_note':
        return await runWriteNote(ctx.app, args, toolUseId, ctx.approve);
      case 'edit_note':
        return await runEditNote(ctx.app, args, toolUseId, ctx.approve);
      case 'append_to_note':
        return await runAppendToNote(ctx.app, args, toolUseId, ctx.approve);
      case 'remember_fact':
        return await runRememberFact(
          ctx.app,
          args,
          toolUseId,
          ctx.approve,
          ctx.memoryPath,
        );
      case 'update_memory':
        return await runUpdateMemory(
          ctx.app,
          args,
          toolUseId,
          ctx.approve,
          ctx.memoryPath,
        );
      case 'forget_fact':
        return await runForgetFact(
          ctx.app,
          args,
          toolUseId,
          ctx.approve,
          ctx.memoryPath,
        );
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
