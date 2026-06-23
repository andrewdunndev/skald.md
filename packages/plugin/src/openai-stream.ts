/**
 * OpenAI → Anthropic streaming event translator.
 *
 * OpenAI sends flat `choices[].delta` chunks; the internal app consumes
 * Anthropic-shaped SSE events. This module synthesises Anthropic events
 * from an OpenAI stream — one stateful translator per stream (call the
 * factory once, pass each parsed chunk to the returned function).
 *
 * Field paths emitted here MUST match the exact paths that handleChunk
 * in chat-session.ts reads:
 *   content_block_start  → d.index, d.content_block (type, id?, name?)
 *   content_block_delta  → d.index, d.delta.type, d.delta.text (text_delta),
 *                          d.delta.partial_json (input_json_delta),
 *                          d.delta.thinking (thinking_delta)
 *   content_block_stop   → d.index
 *   message_start        → d.message.usage.{input_tokens,output_tokens}
 *   message_delta        → d.delta.stop_reason, d.usage.{input_tokens,output_tokens}
 *
 * Map rules (finish_reason → stop_reason):
 *   'tool_calls'     → 'tool_use'     ← critical; wrong = tools never execute
 *   'stop'           → 'end_turn'
 *   'length'         → 'max_tokens'
 *   'content_filter' → 'end_turn'
 *   <anything else>  → 'end_turn'
 */

export interface SynthEvent {
  event: string;
  data: unknown;
}

interface ToolState {
  blockIndex: number;
  id: string;
  name: string;
  /** Whether content_block_start has been emitted for this tool. */
  started: boolean;
}

/**
 * Factory: call once per stream, reuse the returned translator for every
 * parsed chunk from that stream.
 *
 * @param data - The parsed JSON payload of one OpenAI SSE frame, or `null`
 *               for the [DONE] sentinel (which arrives as null from SSEParser).
 * @returns 0..N synthetic Anthropic events.
 */
export function makeOpenAiStreamTranslator(): (data: unknown) => SynthEvent[] {
  // ── Per-stream state ─────────────────────────────────────────────────────────
  let messageStartEmitted = false;
  let nextBlockIndex = 0;

  // Text block state
  let textBlockIndex = -1; // -1 = no open text block

  // Tool state keyed by OpenAI tool_calls[].index
  const toolMap = new Map<number, ToolState>();

  // Thinking block state
  let thinkingBlockIndex = -1; // -1 = no open thinking block

  // Captured usage (populated from 'usage' field on final chunk)
  let capturedInputTokens = 0;
  let capturedOutputTokens = 0;

  // Whether we've emitted message_stop (to avoid duplicates on [DONE])
  let messageStopEmitted = false;

  // Whether we've emitted the finish-reason message_delta (stop_reason)
  let finishEmitted = false;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function nextIdx(): number {
    return nextBlockIndex++;
  }

  function mapStopReason(finishReason: string): string {
    switch (finishReason) {
      case 'tool_calls':     return 'tool_use';
      case 'stop':           return 'end_turn';
      case 'length':         return 'max_tokens';
      case 'content_filter': return 'end_turn';
      default:               return 'end_turn';
    }
  }

  // ── Main translator ──────────────────────────────────────────────────────────

  return function translate(data: unknown): SynthEvent[] {
    // [DONE] arrives as null from SSEParser (it replaces data with null).
    if (data === null) {
      if (messageStopEmitted) return [];
      messageStopEmitted = true;
      return [{ event: 'message_stop', data: { type: 'message_stop' } }];
    }

    const chunk = data as Record<string, unknown>;
    const events: SynthEvent[] = [];

    // ── Error frame ────────────────────────────────────────────────────────────
    if (chunk.error) {
      events.push({ event: 'error', data: chunk.error });
      return events;
    }

    // ── message_start (once, on first chunk) ──────────────────────────────────
    if (!messageStartEmitted) {
      messageStartEmitted = true;
      events.push({
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      });
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;

    // ── Late-arriving usage (usually on the final empty-choices chunk) ─────────
    const usageRaw = chunk.usage as Record<string, number> | null | undefined;
    if (usageRaw && typeof usageRaw === 'object') {
      capturedInputTokens  = (usageRaw.prompt_tokens    as number | undefined) ?? capturedInputTokens;
      capturedOutputTokens = (usageRaw.completion_tokens as number | undefined) ?? capturedOutputTokens;
    }

    // ── No choices (keepalive or usage-only chunk) ─────────────────────────────
    if (!choices || choices.length === 0) {
      // If we have captured usage and finish was already emitted, emit a second
      // message_delta carrying the usage (pump merges via spread).
      if (usageRaw && finishEmitted) {
        events.push({
          event: 'message_delta',
          data: {
            type: 'message_delta',
            delta: { stop_reason: null },
            usage: { input_tokens: capturedInputTokens, output_tokens: capturedOutputTokens },
          },
        });
      }
      return events;
    }

    const choice = choices[0] as Record<string, unknown>;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const finishReason = choice.finish_reason as string | null | undefined;

    // ── delta.content — plain text ─────────────────────────────────────────────
    const textContent = delta.content as string | null | undefined;
    if (typeof textContent === 'string' && textContent.length > 0) {
      if (textBlockIndex === -1) {
        textBlockIndex = nextIdx();
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: { type: 'text' },
          },
        });
      }
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: textContent },
        },
      });
    }

    // ── delta.tool_calls — function calls ─────────────────────────────────────
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | null | undefined;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const oaiIndex = tc.index as number;
        const fn = (tc.function ?? {}) as Record<string, unknown>;

        if (!toolMap.has(oaiIndex)) {
          // First sight of this tool index — assign a block index and capture metadata.
          const blockIdx = nextIdx();
          // Synthesise a stable id when the server omits one (some OpenAI-
          // compatible servers stream tool_calls without an id). A bare '' id
          // would break the downstream tool_result → tool_call_id match, so
          // derive a deterministic id from the tool index instead.
          const id =
            typeof tc.id === 'string' && tc.id.length > 0
              ? tc.id
              : `call_skald_stream_${oaiIndex}`;
          const name = typeof fn.name === 'string' ? fn.name : '';
          toolMap.set(oaiIndex, { blockIndex: blockIdx, id, name, started: false });
        }

        const state = toolMap.get(oaiIndex)!;

        // Emit content_block_start once per tool
        if (!state.started) {
          state.started = true;
          events.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: state.blockIndex,
              content_block: { type: 'tool_use', id: state.id, name: state.name },
            },
          });
        }

        // Emit argument fragment (may be '' for the first chunk that carried id+name)
        const argsFragment = typeof fn.arguments === 'string' ? fn.arguments : '';
        // Always emit input_json_delta — even '' is harmless and keeps index order intact.
        // However skip empty fragments to avoid spurious deltas on the id-bearing chunk.
        if (argsFragment.length > 0) {
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: state.blockIndex,
              delta: { type: 'input_json_delta', partial_json: argsFragment },
            },
          });
        }
      }
    }

    // ── delta.reasoning_content — thinking (o-series / some OSS models) ────────
    // handleChunk reads: delta.type === 'thinking_delta', delta.thinking
    const reasoning = delta.reasoning_content as string | null | undefined;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (thinkingBlockIndex === -1) {
        thinkingBlockIndex = nextIdx();
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: thinkingBlockIndex,
            content_block: { type: 'thinking' },
          },
        });
      }
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: thinkingBlockIndex,
          delta: { type: 'thinking_delta', thinking: reasoning },
        },
      });
    }

    // ── finish_reason — close all open blocks then emit message_delta ──────────
    if (finishReason != null && finishReason !== '') {
      finishEmitted = true;

      // Close open blocks in index order.
      // Collect all open block indices and sort them.
      const openBlocks: Array<{ idx: number }> = [];
      if (textBlockIndex !== -1) openBlocks.push({ idx: textBlockIndex });
      if (thinkingBlockIndex !== -1) openBlocks.push({ idx: thinkingBlockIndex });
      for (const state of toolMap.values()) {
        if (state.started) openBlocks.push({ idx: state.blockIndex });
      }
      openBlocks.sort((a, b) => a.idx - b.idx);

      for (const { idx } of openBlocks) {
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: idx },
        });
      }

      const stopReason = mapStopReason(finishReason);

      // Include captured usage if available (stream_options: include_usage
      // may have already arrived, or will arrive on a subsequent empty-choices chunk).
      events.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { input_tokens: capturedInputTokens, output_tokens: capturedOutputTokens },
        },
      });
    }

    return events;
  };
}
