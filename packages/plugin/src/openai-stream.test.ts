/**
 * openai-stream: stateful OpenAI → Anthropic stream translator tests.
 * Feeds parsed OpenAI chunk objects to the factory and asserts synthetic events.
 * Field paths verified against handleChunk in chat-session.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { makeOpenAiStreamTranslator } from './openai-stream';
import type { SynthEvent } from './openai-stream';
import { translateOpenRouterEvent } from './openrouter-translate';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect ALL events from a sequence of chunks via a fresh translator. */
function runChunks(chunks: unknown[]): SynthEvent[] {
  const translate = makeOpenAiStreamTranslator();
  return chunks.flatMap((c) => translate(c));
}

/** Pull all events of a given name from an event list. */
function byEvent(events: SynthEvent[], name: string): SynthEvent[] {
  return events.filter((e) => e.event === name);
}

function dataOf(e: SynthEvent): Record<string, unknown> {
  return e.data as Record<string, unknown>;
}

// ── Chunk builders ─────────────────────────────────────────────────────────

function textChunk(text: string, finishReason: string | null = null) {
  return { choices: [{ delta: { content: text }, finish_reason: finishReason }] };
}

function toolStartChunk(oaiIndex: number, id: string, name: string) {
  return {
    choices: [{
      delta: { tool_calls: [{ index: oaiIndex, id, type: 'function', function: { name, arguments: '' } }] },
      finish_reason: null,
    }],
  };
}

function toolArgChunk(oaiIndex: number, args: string, finishReason: string | null = null) {
  return {
    choices: [{
      delta: { tool_calls: [{ index: oaiIndex, id: '', type: 'function', function: { name: '', arguments: args } }] },
      finish_reason: finishReason,
    }],
  };
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

function keepaliveChunk() {
  return { choices: [] };
}

// ── 1. Plain text stream ──────────────────────────────────────────────────────

describe('plain text stream', () => {
  // Simulate: first chunk has text, second has more text, third finishes.
  const chunks = [
    textChunk('Hello'),
    textChunk(' world'),
    textChunk('', 'stop'),
  ];

  let events: SynthEvent[];
  beforeEach(() => { events = runChunks(chunks); });

  it('emits message_start as the very first event', () => {
    expect(events[0].event).toBe('message_start');
    const d = dataOf(events[0]);
    expect((d.message as Record<string, unknown>)?.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('emits content_block_start with type text', () => {
    const starts = byEvent(events, 'content_block_start');
    expect(starts).toHaveLength(1);
    const d = dataOf(starts[0]);
    expect(d.index).toBe(0);
    expect((d.content_block as Record<string, unknown>)?.type).toBe('text');
  });

  it('emits two content_block_delta text_delta events with correct text', () => {
    const deltas = byEvent(events, 'content_block_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.every((e) => (dataOf(e).delta as Record<string, unknown>).type === 'text_delta')).toBe(true);
    const texts = deltas.map((e) => (dataOf(e).delta as Record<string, unknown>).text as string);
    expect(texts.join('')).toBe('Hello world');
  });

  it('emits content_block_stop at index 0', () => {
    const stops = byEvent(events, 'content_block_stop');
    expect(stops).toHaveLength(1);
    expect(dataOf(stops[0]).index).toBe(0);
  });

  it('emits message_delta with stop_reason end_turn (mapped from stop)', () => {
    const deltas = byEvent(events, 'message_delta');
    expect(deltas).toHaveLength(1);
    const d = dataOf(deltas[0]);
    expect((d.delta as Record<string, unknown>)?.stop_reason).toBe('end_turn');
  });

  it('emits message_start only once (not per chunk)', () => {
    expect(byEvent(events, 'message_start')).toHaveLength(1);
  });
});

// ── 2. Tool-call stream (critical path) ───────────────────────────────────────

describe('tool-call stream — CRITICAL', () => {
  // OpenAI shape: first chunk carries id+name, subsequent chunks carry arguments.
  const chunks = [
    toolStartChunk(0, 'call_abc', 'read_note'),
    toolArgChunk(0, '{"path"'),
    toolArgChunk(0, ':"x.md"}', 'tool_calls'),
  ];

  let events: SynthEvent[];
  beforeEach(() => { events = runChunks(chunks); });

  it('emits message_start first', () => {
    expect(events[0].event).toBe('message_start');
  });

  it('emits content_block_start with type tool_use, correct id and name', () => {
    const starts = byEvent(events, 'content_block_start');
    expect(starts).toHaveLength(1);
    const d = dataOf(starts[0]);
    const cb = d.content_block as Record<string, unknown>;
    expect(cb.type).toBe('tool_use');
    expect(cb.id).toBe('call_abc');
    expect(cb.name).toBe('read_note');
    expect(d.index).toBe(0);
  });

  it('emits two input_json_delta events with the JSON fragments', () => {
    const deltas = byEvent(events, 'content_block_delta');
    expect(deltas).toHaveLength(2);
    for (const delta of deltas) {
      const dd = (dataOf(delta).delta as Record<string, unknown>);
      expect(dd.type).toBe('input_json_delta');
    }
    const fragments = deltas.map(
      (e) => (dataOf(e).delta as Record<string, unknown>).partial_json as string,
    );
    expect(fragments.join('')).toBe('{"path":"x.md"}');
  });

  it('emits content_block_stop at the tool block index', () => {
    const stops = byEvent(events, 'content_block_stop');
    expect(stops).toHaveLength(1);
    expect(dataOf(stops[0]).index).toBe(0);
  });

  it('emits message_delta with stop_reason tool_use (mapped from tool_calls)', () => {
    const mds = byEvent(events, 'message_delta');
    expect(mds).toHaveLength(1);
    const d = dataOf(mds[0]);
    expect((d.delta as Record<string, unknown>)?.stop_reason).toBe('tool_use');
  });
});

// ── 3. Whole tool call in one chunk (LiteLLM shape) ───────────────────────────

describe('whole-tool-call-in-one-chunk (LiteLLM shape)', () => {
  // LiteLLM may deliver id+name+full arguments in a single chunk.
  const chunks = [
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_xyz',
            type: 'function',
            function: { name: 'write_note', arguments: '{"path":"a.md","content":"hi"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  ];

  let events: SynthEvent[];
  beforeEach(() => { events = runChunks(chunks); });

  it('emits content_block_start with id and name', () => {
    const starts = byEvent(events, 'content_block_start');
    expect(starts).toHaveLength(1);
    const cb = dataOf(starts[0]).content_block as Record<string, unknown>;
    expect(cb.type).toBe('tool_use');
    expect(cb.id).toBe('call_xyz');
    expect(cb.name).toBe('write_note');
  });

  it('emits exactly one input_json_delta with the full JSON', () => {
    const deltas = byEvent(events, 'content_block_delta');
    expect(deltas).toHaveLength(1);
    const dd = dataOf(deltas[0]).delta as Record<string, unknown>;
    expect(dd.type).toBe('input_json_delta');
    expect(dd.partial_json).toBe('{"path":"a.md","content":"hi"}');
  });

  it('emits content_block_stop', () => {
    expect(byEvent(events, 'content_block_stop')).toHaveLength(1);
  });

  it('maps finish_reason tool_calls → stop_reason tool_use', () => {
    const mds = byEvent(events, 'message_delta');
    expect(mds).toHaveLength(1);
    const stop = (dataOf(mds[0]).delta as Record<string, unknown>)?.stop_reason;
    expect(stop).toBe('tool_use');
  });
});

// ── 4. Parallel tool calls (two indices) ────────────────────────────────────

describe('parallel tool calls (two OpenAI indices)', () => {
  const chunks = [
    {
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'c1', type: 'function', function: { name: 'read_a', arguments: '' } },
            { index: 1, id: 'c2', type: 'function', function: { name: 'read_b', arguments: '' } },
          ],
        },
        finish_reason: null,
      }],
    },
    toolArgChunk(0, '{"path":"a.md"}'),
    toolArgChunk(1, '{"path":"b.md"}', 'tool_calls'),
  ];

  let events: SynthEvent[];
  beforeEach(() => { events = runChunks(chunks); });

  it('emits two content_block_start events with distinct indices', () => {
    const starts = byEvent(events, 'content_block_start');
    expect(starts).toHaveLength(2);
    const indices = starts.map((e) => dataOf(e).index as number);
    expect(new Set(indices).size).toBe(2);
  });

  it('each content_block_start carries the correct tool id and name', () => {
    const starts = byEvent(events, 'content_block_start');
    const byIdx = Object.fromEntries(
      starts.map((e) => {
        const d = dataOf(e);
        return [d.index as number, d.content_block as Record<string, unknown>];
      }),
    );
    expect(byIdx[0]?.id).toBe('c1');
    expect(byIdx[0]?.name).toBe('read_a');
    expect(byIdx[1]?.id).toBe('c2');
    expect(byIdx[1]?.name).toBe('read_b');
  });

  it('emits two content_block_stop events', () => {
    expect(byEvent(events, 'content_block_stop')).toHaveLength(2);
  });

  it('emits message_delta with stop_reason tool_use', () => {
    const mds = byEvent(events, 'message_delta');
    const stop = (dataOf(mds[mds.length - 1]).delta as Record<string, unknown>)?.stop_reason;
    expect(stop).toBe('tool_use');
  });
});

// ── 5. Usage chunk (empty choices + usage field) ──────────────────────────────

describe('usage chunk (stream_options include_usage)', () => {
  it('at least one message_delta carries the captured usage tokens', () => {
    const events = runChunks([textChunk('Hi'), finishChunk('stop'), usageChunk(100, 42)]);
    const withUsage = byEvent(events, 'message_delta').filter((e) => {
      const u = (dataOf(e).usage as Record<string, number> | undefined);
      return u?.input_tokens === 100 && u?.output_tokens === 42;
    });
    expect(withUsage.length).toBeGreaterThanOrEqual(1);
  });

  it('usage on the finish chunk is embedded in the single message_delta', () => {
    const chunk = {
      choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    };
    const events = runChunks([chunk]);
    const mds = byEvent(events, 'message_delta');
    expect(mds).toHaveLength(1);
    const u = dataOf(mds[0]).usage as Record<string, number>;
    expect(u.input_tokens).toBe(50);
    expect(u.output_tokens).toBe(20);
  });
});

// ── 6. Keepalive empty-choices chunk ─────────────────────────────────────────

describe('keepalive empty-choices chunk', () => {
  it('subsequent keepalives after message_start emit no events', () => {
    const translate = makeOpenAiStreamTranslator();
    const first = translate(keepaliveChunk()); // message_start on first call
    expect(first.map((e) => e.event)).toContain('message_start');
    const second = translate(keepaliveChunk()); // nothing after that
    expect(second).toHaveLength(0);
  });
});

// ── 7. Mid-stream error object ────────────────────────────────────────────────

describe('mid-stream error', () => {
  it('surfaces an error event when the parsed data carries an error field', () => {
    const events = runChunks([{ error: { type: 'rate_limit_error', message: 'Too many requests' } }]);
    expect(byEvent(events, 'error')).toHaveLength(1);
    expect((dataOf(byEvent(events, 'error')[0]) as Record<string, unknown>).type).toBe('rate_limit_error');
  });
});

// ── 8. [DONE] / null sentinel ─────────────────────────────────────────────────

describe('[DONE] sentinel (null)', () => {
  it('emits message_stop on null', () => {
    const events = runChunks([null]);
    expect(byEvent(events, 'message_stop')).toHaveLength(1);
  });

  it('does not emit a duplicate message_stop if called twice', () => {
    const translate = makeOpenAiStreamTranslator();
    const first = translate(null);
    const second = translate(null);
    expect(first.map((e) => e.event)).toContain('message_stop');
    expect(second).toHaveLength(0);
  });
});

// ── 9. finish_reason mapping ──────────────────────────────────────────────────

describe('finish_reason → stop_reason mapping', () => {
  const cases: [string, string][] = [
    ['tool_calls',     'tool_use'],   // ← critical
    ['stop',           'end_turn'],
    ['length',         'max_tokens'],
    ['content_filter', 'end_turn'],
    ['unknown_reason', 'end_turn'],   // default
  ];

  for (const [finishReason, expectedStop] of cases) {
    it(`maps '${finishReason}' → '${expectedStop}'`, () => {
      const events = runChunks([finishChunk(finishReason)]);
      const mds = byEvent(events, 'message_delta');
      const stop = (dataOf(mds[0]).delta as Record<string, unknown>)?.stop_reason;
      expect(stop).toBe(expectedStop);
    });
  }
});

// ── 10. Thinking / reasoning_content ─────────────────────────────────────────

describe('reasoning_content (thinking) block', () => {
  it('emits a thinking content_block_start and thinking_delta', () => {
    const chunk = {
      choices: [{ delta: { reasoning_content: 'let me think...' }, finish_reason: null }],
    };
    const events = runChunks([chunk]);
    const starts = byEvent(events, 'content_block_start');
    expect(starts).toHaveLength(1);
    expect((dataOf(starts[0]).content_block as Record<string, unknown>)?.type).toBe('thinking');

    const deltas = byEvent(events, 'content_block_delta');
    expect(deltas).toHaveLength(1);
    const dd = dataOf(deltas[0]).delta as Record<string, unknown>;
    expect(dd.type).toBe('thinking_delta');
    expect(dd.thinking).toBe('let me think...');
  });
});

// ── 11. Regression: pump generalisation does not break OpenRouter ────────────

describe('regression: openrouter translator unchanged', () => {
  it('translateOpenRouterEvent returns identity for pass-through events', () => {
    // Real regression guard: the 17 tests in direct-transport.test.ts.
    // This is a structural smoke-check that the imported function still works.
    const result = translateOpenRouterEvent('content_block_start', { index: 0, content_block: { type: 'text' } });
    expect(result.event).toBe('content_block_start');
    expect(result.data).toEqual({ index: 0, content_block: { type: 'text' } });
  });
});
