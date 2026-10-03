/**
 * Agentic tool-execution leg for ChatSession.
 *
 * Extracted from chat-session.ts (DEVIATIONS: "extract agentic-loop
 * logic to chat-session-tool-loop.ts") so the session file stays under
 * the LOC cap. This is the pure part of a tool leg: given the assistant
 * blocks that requested tools, run them (read-only concurrently, writes
 * sequentially), reassemble tool_result blocks in original order, and —
 * when citations are enabled — append grounding document blocks. The
 * caller owns pushing the resulting user turn into history + dispatching
 * the continuation, so message/transport coupling stays in the class.
 */
import type { ContentBlock } from './protocol';
import { isReadOnlyTool } from './tools';
import { buildDocumentBlock } from './citations';
import type { ToolExecutor } from './chat-session';

export interface ToolLegContext {
  toolExecutor: ToolExecutor;
  /** Whether the Citations grounding path is active for this turn. */
  citationsEnabled: boolean;
  /** document_index → vault path sink, populated for citation grounding. */
  documentRegistry: Map<number, string>;
}

/**
 * Execute every tool_use block in `blocks` and return the tool_result
 * (and, when grounding, document) blocks that form the next user turn.
 * Returns an empty array when there are no tool uses (the caller treats
 * that as "nothing to continue"). Per-leg document registry clearing is
 * the caller's job before invoking (document_index is per-request).
 */
export async function executeToolLeg(
  ctx: ToolLegContext,
  blocks: ContentBlock[],
): Promise<ContentBlock[]> {
  const toolUses = blocks.filter(
    (b) => (b as Record<string, unknown>).type === 'tool_use',
  );
  if (toolUses.length === 0) return [];

  // Partition into read-only (parallelisable) and write (sequential).
  const readUses: typeof toolUses = [];
  const writeUses: typeof toolUses = [];
  for (const block of toolUses) {
    const name = (block as Record<string, unknown>).name as string;
    if (isReadOnlyTool(name)) readUses.push(block);
    else writeUses.push(block);
  }

  // Map from tool_use_id → result block for reassembly in original order.
  const resultMap = new Map<string, ContentBlock>();

  const toResultBlock = (
    id: string,
    res: { content: string; is_error?: boolean },
  ): ContentBlock => {
    const rb: ContentBlock = { type: 'tool_result', tool_use_id: id, content: res.content };
    if (res.is_error) (rb as Record<string, unknown>).is_error = true;
    return rb;
  };

  const runOne = async (block: ContentBlock): Promise<void> => {
    const b = block as Record<string, any>;
    try {
      const res = await ctx.toolExecutor(b.name, b.input, b.id);
      resultMap.set(b.id, toResultBlock(b.id, res));
    } catch (err) {
      resultMap.set(
        b.id,
        toResultBlock(b.id, {
          content: err instanceof Error ? err.message : 'tool execution failed',
          is_error: true,
        }),
      );
    }
  };

  // Execute read-only tools concurrently. A thrown read → error
  // tool_result (never a missing block, so no tool_use is orphaned).
  await Promise.all(readUses.map(runOne));
  // Execute write tools strictly sequentially (approval UIs must not overlap).
  for (const block of writeUses) await runOne(block);

  // Reassemble in original tool_use order for determinism.
  const results: ContentBlock[] = toolUses.map((block) => {
    const id = (block as Record<string, unknown>).id as string;
    return resultMap.get(id)!;
  });

  // Citations path: append document blocks for read_note results so the
  // Citations API can ground citations. Body travels once in source.data;
  // the tool_result.content is collapsed to the path to avoid duplication.
  if (ctx.citationsEnabled) {
    let docIdx = 0;
    for (const block of toolUses) {
      const b = block as Record<string, any>;
      if (b.name !== 'read_note') continue;
      const path = typeof b.input?.path === 'string' ? b.input.path : null;
      const res = resultMap.get(b.id as string) as Record<string, unknown> | undefined;
      const body = res && !res.is_error ? (res.content as string) : null;
      if (!path || !body || !res) continue;
      let docBlock: ContentBlock;
      try { docBlock = buildDocumentBlock(path, body) as unknown as ContentBlock; }
      catch { continue; }
      results.push(docBlock);
      // Collapse the body out of the tool_result (same obj in `results`);
      // it now lives once in the doc block.
      res.content = `[${path}]`;
      ctx.documentRegistry.set(docIdx, path);
      docIdx++;
    }
  }

  return results;
}
