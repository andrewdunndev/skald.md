/**
 * Mutation-probe tests for transport-timeouts.ts and the request-timeout
 * wiring in DirectTransport.
 *
 * These tests were written after confirming that the existing suite does NOT
 * catch the following mutation: REQUEST_TIMEOUT_MS set to a value so large
 * the timer never fires within a test run.
 *
 * Two guards covered:
 *
 *   1. composeSignal(outer, ms) — signal fires when ms elapses (unit, real timers).
 *      AbortSignal.timeout() uses the runtime's native timer (not setTimeout),
 *      so this test runs with real timers and a tiny synthetic deadline.
 *
 *   2. DirectTransport fetch wiring — composeSignal IS invoked with REQUEST_TIMEOUT_MS
 *      as the deadline. Verified by spying on the module export; a broken constant
 *      (e.g. 999_999_999) changes the spy-recorded argument and fails this assertion.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from './protocol';
import * as timeoutsModule from './transport-timeouts';
import { DirectTransport } from './direct-transport';

// ---------------------------------------------------------------------------
// Unit: composeSignal timer leg (real timers — AbortSignal.timeout is native)
// ---------------------------------------------------------------------------

describe('composeSignal: timer leg', () => {
  it('fires when the specified ms elapses', async () => {
    const outer = new AbortController();
    // Use a tiny synthetic timeout so the test completes in real time.
    const composed = timeoutsModule.composeSignal(outer.signal, 50);
    expect(composed.aborted).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(composed.aborted).toBe(true);
  }, 1_000);

  it('fires when the outer signal fires (before timeout)', () => {
    const outer = new AbortController();
    const composed = timeoutsModule.composeSignal(outer.signal, 60_000);
    expect(composed.aborted).toBe(false);
    outer.abort();
    expect(composed.aborted).toBe(true);
  });

  it('is already aborted when outer is pre-aborted', () => {
    const outer = new AbortController();
    outer.abort();
    const composed = timeoutsModule.composeSignal(outer.signal, 60_000);
    expect(composed.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: DirectTransport calls composeSignal with REQUEST_TIMEOUT_MS
//
// This test spies on composeSignal to verify the transport passes the
// current REQUEST_TIMEOUT_MS constant as the deadline.  If the constant were
// mutated to an enormous value (e.g. 999_999_999), the assertion on the ms
// argument catches it.  The fetch mock resolves immediately so we don't need
// to wait for the timer to fire.
// ---------------------------------------------------------------------------

describe('DirectTransport: composeSignal is wired with REQUEST_TIMEOUT_MS', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes REQUEST_TIMEOUT_MS as the deadline to composeSignal', async () => {
    // Spy BEFORE constructing the transport so the import binding is intercepted.
    const composeSpy = vi.spyOn(timeoutsModule, 'composeSignal');

    // Minimal SSE — resolves the fetch immediately so we don't need to advance timers.
    const encoder = new TextEncoder();
    const sseData =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseData));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));

    const messages: ServerMessage[] = [];
    const handlers = {
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onMessage: vi.fn((m: ServerMessage) => messages.push(m)),
      onError: vi.fn(),
    };
    const transport = new DirectTransport(
      { getAnthropicKey: () => 'sk-ant-test', getOpenRouterKey: () => '' },
      handlers,
    );
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'req-timeout-spy',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    // composeSignal must have been called exactly once for the fetch signal,
    // and the ms argument must equal the exported REQUEST_TIMEOUT_MS constant.
    expect(composeSpy).toHaveBeenCalledOnce();
    const [, msArg] = composeSpy.mock.calls[0];
    expect(msArg).toBe(timeoutsModule.REQUEST_TIMEOUT_MS);
    // Sanity: the constant itself must be a sane value (not huge, not tiny).
    expect(timeoutsModule.REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(timeoutsModule.REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
