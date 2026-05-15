import type { ToolDefinition } from '@scribian/protocol';
import { executeFindRelated } from '../memory-client';
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
  MEMORY_TOOLS,
  WRITE_TOOLS,
  runWriteNote,
  runEditNote,
  runAppendToNote,
  runRememberFact,
  runUpdateMemory,
  runForgetFact,
} from './write';
import { SERVER_TOOLS } from './server';

export type {
  ApproveFn,
  ToolContext,
  ToolExecutionResult,
  WriteKind,
  WriteProposal,
} from './context';
export { READ_ONLY_TOOLS, WRITE_TOOLS, MEMORY_TOOLS, SERVER_TOOLS };

/**
 * Every tool definition shipped on a chat request. Plugin dispatches
 * READ_ONLY_TOOLS + WRITE_TOOLS + MEMORY_TOOLS through executeTool;
 * SERVER_TOOLS execute on the provider side and never reach the
 * executor.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...READ_ONLY_TOOLS,
  ...WRITE_TOOLS,
  ...MEMORY_TOOLS,
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
      case 'find_related':
        if (!ctx.memoryClient) {
          return {
            content:
              'find_related: memory client not configured. Set the Worker URL + token in plugin settings.',
            is_error: true,
          };
        }
        return await executeFindRelated(ctx.app, ctx.memoryClient, input);
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
