import type { App } from 'obsidian';
import type { Logger } from '../logger';
import type { Transport } from '../transport';
import { executeTool } from '../tools';
import type { MemoryClientConfig } from '../memory-client';

export interface McpBridgeContext {
  app: App;
  transport: Transport;
  logger: Logger;
  memoryClient: MemoryClientConfig;
}

/**
 * Compact summary of tool input for audit log lines. Per-tool because
 * the interesting field name varies (path / folder / query / etc.) and
 * full-input JSON gets noisy.
 */
function summarizeToolInput(name: string, input: unknown): string {
  const i = (input as Record<string, any>) ?? {};
  if (name === 'read_note' || name === 'metadata') return `path=${i.path ?? '?'}`;
  if (name === 'list_notes')
    return `folder=${i.folder ?? '(all)'} limit=${i.limit ?? 50}`;
  if (name === 'search_vault') return `query="${i.query ?? '?'}"`;
  if (name === 'current_note') return '';
  return JSON.stringify(input ?? {}).slice(0, 100);
}

/**
 * Bridge an MCP tool call from an external client (Claude Code,
 * Cursor, etc.) routed through our Worker. Executes locally with a
 * read-only approval policy (writes auto-reject), audit-logs every
 * call + outcome, and replies with mcp_result on the same transport.
 */
export async function handleMcpCall(
  ctx: McpBridgeContext,
  id: string,
  name: string,
  input: unknown,
  callerLabel?: string,
): Promise<void> {
  const caller = callerLabel ?? 'unknown';
  const inputSummary = summarizeToolInput(name, input);
  ctx.logger.info(`mcp_call from=${caller} tool=${name} ${inputSummary}`);
  try {
    const result = await executeTool(name, input, id, {
      app: ctx.app,
      // MCP read-only path: no write tools allowed, so no approval is
      // ever requested. Auto-reject any write-tool approval attempt
      // (defense in depth — Worker also gates writes at the MCP edge).
      approve: async () => false,
      memoryClient: ctx.memoryClient,
    });
    if (result.is_error) {
      ctx.logger.warn(
        `mcp_call error from=${caller} tool=${name}: ${result.content.slice(0, 200)}`,
      );
    } else {
      ctx.logger.info(
        `mcp_call ok from=${caller} tool=${name} bytes=${result.content.length}`,
      );
    }
    ctx.transport.send({
      type: 'mcp_result',
      id,
      content: result.content,
      ...(result.is_error ? { is_error: true } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'tool execution failed';
    ctx.logger.error(`mcp_call exception from=${caller} tool=${name}: ${msg}`);
    ctx.transport.send({
      type: 'mcp_result',
      id,
      content: msg,
      is_error: true,
    });
  }
}
