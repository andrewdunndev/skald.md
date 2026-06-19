/**
 * Payload-composition integration test for the Anthropic dispatch path.
 *
 * direct-transport.test.ts exercises each shaping concern in isolation
 * (caching breakpoints, thinking bump, tool rewriting). This file pins the
 * one real flight path none of those touch: a single request that combines
 * ALL of them at once — extended thinking ON, a system prompt, a tool set
 * (including a server web_search tool), citations enabled (a document block
 * already in the message history from a prior read_note), and multi-turn
 * history. The interactions between these shapers are where regressions hide:
 *
 *   1. max_tokens must be bumped ABOVE the thinking budget (else Anthropic
 *      400s — budget is carved out of max_tokens).
 *   2. Anthropic allows at most 4 cache_control breakpoints; the caching
 *      pass must stay within that ceiling when system + tools + history all
 *      qualify for one.
 *   3. The document block (citations shaping) must survive untouched and
 *      coexist with the cache breakpoints — caching must not clobber it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from '@skald/protocol';
import { DirectTransport } from './direct-transport';

const MINIMAL_SSE =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function countCacheControl(obj: unknown): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'cache_control') n++;
        else walk(val);
      }
    }
  };
  walk(obj);
  return n;
}

describe('DirectTransport: full Anthropic payload composition', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(sseStream(MINIMAL_SSE), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function sendComposite() {
    const transport = new DirectTransport(
      {
        getAnthropicKey: () => 'sk-ant-test',
        getOpenRouterKey: () => '',
        getThinkingEnabled: () => true,
      },
      {
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onMessage: vi.fn((_m: ServerMessage) => {}),
        onError: vi.fn(),
      },
    );
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'composite',
      payload: {
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        system: 'You are a vault assistant.',
        tools: [
          { name: 'read_note', input_schema: {} },
          { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
          { name: 'write_note', input_schema: {} },
        ],
        messages: [
          { role: 'user', content: 'summarize my note' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'r1', name: 'read_note', input: { path: 'A.md' } },
            ],
          },
          {
            // Prior tool-result turn carries the citations document block.
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'r1', content: '[A.md]' },
              {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'note body' },
                title: 'A.md',
                citations: { enabled: true },
              },
            ],
          },
          { role: 'user', content: 'now what stands out?' },
        ],
      },
    });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    return JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
  }

  it('bumps max_tokens above the thinking budget', async () => {
    const body = await sendComposite();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
  });

  it('keeps total cache_control breakpoints within the Anthropic limit of 4', async () => {
    const body = await sendComposite();
    const total = countCacheControl(body);
    expect(total).toBeGreaterThan(0); // caching is actually applied
    expect(total).toBeLessThanOrEqual(4);
  });

  it('preserves the citations document block alongside the caching shape', async () => {
    const body = await sendComposite();
    // The document block from the prior tool-result turn must survive intact.
    const docTurn = body.messages.find(
      (m: any) =>
        Array.isArray(m.content) &&
        m.content.some((b: any) => b.type === 'document'),
    );
    expect(docTurn).toBeDefined();
    const doc = docTurn.content.find((b: any) => b.type === 'document');
    expect(doc.citations).toEqual({ enabled: true });
    expect(doc.source.data).toBe('note body');
    // The system prompt is still cached (shaping coexists, not overwritten).
    expect(body.system[0].cache_control.type).toBe('ephemeral');
  });
});
