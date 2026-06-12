import type { ToolDefinition } from '@scribian/protocol';
import { executeFindRelated } from '../memory-client';
import type { ToolContext, ToolExecutionResult } from './context';
import type { ConnectionMode } from '../settings';
import { modeCapabilities } from '../mode-capabilities';
import {
  READ_ONLY_TOOLS,
  runReadNote,
  runListNotes,
  runSearchVault,
  runCurrentNote,
  runMetadata,
} from './read';
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
export { READ_ONLY_TOOLS, WRITE_TOOLS, MEMORY_TOOLS, SERVER_TOOLS, serverToolsForModel };

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
   * Connection mode. find_related is only available when the mode's
   * semanticSearch capability is true (currently 'worker' only).
   * Server tools (web_search / web_fetch) work in all modes.
   * executeTool gates the call site as defense-in-depth.
   */
  connectionMode?: ConnectionMode;
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
  // Exclude find_related when the mode lacks semantic search (requires
  // the Worker's Vectorize binding). The executor gate remains as
  // defense-in-depth. When connectionMode is absent, default to 'worker'
  // behavior (include the tool) for backward compatibility.
  const caps = input.connectionMode
    ? modeCapabilities(input.connectionMode)
    : { semanticSearch: true };
  const readTools = caps.semanticSearch
    ? READ_ONLY_TOOLS
    : READ_ONLY_TOOLS.filter(
        (t) => (t as Record<string, unknown>).name !== 'find_related',
      );

  const tools: ToolDefinition[] = [...readTools, ...WRITE_TOOLS];
  if (input.memoryEnabled && input.memoryPath.trim()) {
    tools.push(...MEMORY_TOOLS);
  }
  // Server tools (web_search / web_fetch) work in both modes — they
  // execute on the provider side regardless of how we connect.
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
      case 'find_related': {
        // Defense-in-depth: if the mode lacks semanticSearch, the tool
        // should not have appeared in the catalog — but guard here too.
        const findCaps = ctx.connectionMode
          ? modeCapabilities(ctx.connectionMode)
          : { semanticSearch: true };
        if (!findCaps.semanticSearch) {
          return {
            content:
              'find_related requires semantic search (Worker mode). Switch to Worker mode in plugin settings to enable it.',
            is_error: true,
          };
        }
        if (!ctx.memoryClient) {
          return {
            content:
              'find_related: memory client not configured. Set the Worker URL + token in plugin settings.',
            is_error: true,
          };
        }
        return await executeFindRelated(ctx.app, ctx.memoryClient, input);
      }
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
