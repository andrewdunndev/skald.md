/**
 * openai-stream: late-usage shape + streamed tool-id synthesis.
 *
 * Two edge cases the main translator suite under-asserts:
 *   - When stream_options.include_usage arrives on a SEPARATE chunk after the
 *     finish chunk, the translator emits a SECOND message_delta whose
 *     delta.stop_reason is explicitly null (so the pump merges usage without
 *     overwriting the real stop_reason). That null shape is asserted here.
 *   - Some OpenAI-compatible servers stream tool_calls with no id; a bare ''
 *     would break the downstream tool_result → tool_call_id match, so the
 *     translator synthesises a deterministic non-empty id.
 */
import { describe, expect, it } from 'vitest';
import { makeOpenAiStreamTranslator } from './openai-stream';
import type { SynthEvent } from './openai-stream';

function runChunks(chunks: unknown[]): SynthEvent[] {
  const translate = makeOpenAiStreamTranslator();
  return chunks.flatMap((c) => translate(c));
}

function byEvent(events: SynthEvent[], name: string): SynthEvent[] {
  return events.filter((e) => e.event === name);
}

function dataOf(e: SynthEvent): Record<string, unknown> {
  return e.data as Record<string, unknown>;
}

function textChunk(text: string, finishReason: string | null = null) {
  return { choices: [{ delta: { content: text }, finish_reason: finishReason }] };
}

function finishChunk(finishReason: string) {
  return { choices: [{ delta: {}, finish_reason: finishReason }] };
}

function usageChunk(promptTokens: number, completionTokens: number) {
  return {
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

describe('late-arriving usage chunk', () => {
  it('emits a SECOND message_delta with stop_reason:null + usage', () => {
    // finish chunk emits message_delta #1 (with stop_reason). The usage chunk
    // arrives afterward and must emit message_delta #2 carrying stop_reason:null
    // so the pump merges usage without clobbering the real stop_reason.
    const events = runChunks([textChunk('Hi'), finishChunk('stop'), usageChunk(100, 42)]);
    const mds = byEvent(events, 'message_delta');
    expect(mds.length).toBe(2);

    // #1 carries the real stop_reason from finish_reason:'stop'.
    const first = dataOf(mds[0]);
    expect((first.delta as Record<string, unknown>).stop_reason).toBe('end_turn');

    // #2 (the late-usage delta) explicitly carries stop_reason:null so the
    // pump's `if (d?.delta?.stop_reason) stopReason = ...` guard ignores it.
    const last = dataOf(mds[mds.length - 1]);
    const lastDelta = last.delta as Record<string, unknown>;
    expect('stop_reason' in lastDelta).toBe(true);
    expect(lastDelta.stop_reason).toBeNull();
    expect(last.usage).toEqual({ input_tokens: 100, output_tokens: 42 });
  });
});

describe('streamed tool_call id synthesis', () => {
  it('synthesises a stable id when the server streams a tool_call with no id', () => {
    const noIdToolStart = {
      choices: [{
        delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'do_it', arguments: '' } }] },
        finish_reason: null,
      }],
    };
    const argChunk = {
      choices: [{
        delta: { tool_calls: [{ index: 0, type: 'function', function: { name: '', arguments: '{"x":1}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const events = runChunks([noIdToolStart, argChunk]);
    const start = byEvent(events, 'content_block_start')[0];
    const block = dataOf(start).content_block as Record<string, unknown>;
    expect(typeof block.id).toBe('string');
    expect((block.id as string).length).toBeGreaterThan(0);
  });
});
