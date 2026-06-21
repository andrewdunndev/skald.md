/**
 * DirectTransport failure-mode tests: Fix 1 (idle timeout) and Fix 2 (null body).
 * Covers the two scenarios where a stalled or incomplete response must surface
 * a retryable error instead of hanging or throwing unhandled.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from '@skald/protocol';
import { DirectTransport } from './direct-transport';

function makeTransport() {
  const messages: ServerMessage[] = [];
  const handlers = {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn((m: ServerMessage) => messages.push(m)),
    onError: vi.fn(),
    messages,
  };
  const transport = new DirectTransport(
    { getAnthropicKey: () => 'sk-ant-test', getOpenRouterKey: () => '' },
    handlers,
  );
  return { transport, handlers };
}

const CHAT_PAYLOAD = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user' as const, content: 'hi' }],
  max_tokens: 100,
};

describe('DirectTransport Fix 2: null response body', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('emits a retryable error (not a throw) when resp.body is null', async () => {
    // Some environments / interceptors return a 200 with a null body.
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'chat', id: 'nb1', payload: CHAT_PAYLOAD });
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.retryable).toBe(true);
      expect(err.error).toContain('resend');
    }
  });
});

describe('DirectTransport Fix 1: idle stream timeout', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('emits a retryable error when the stream stalls beyond STREAM_IDLE_TIMEOUT_MS', async () => {
    // Stream opens but never sends a chunk — simulates a hung connection.
    const stream = new ReadableStream<Uint8Array>({
      start() { /* intentionally idle */ },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'chat', id: 'idle1', payload: CHAT_PAYLOAD });

    // Wait for fetch to be called.
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    // Advance past the idle timeout (60 s).
    await vi.advanceTimersByTimeAsync(61_000);

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error' || m.type === 'done'));
    const msg = handlers.messages.find((m) => m.type === 'error' || m.type === 'done');
    // A stalled stream must surface a retryable error, not a done(end_turn).
    expect(msg?.type).toBe('error');
    if (msg?.type === 'error') {
      expect(msg.retryable).toBe(true);
    }
  });

  it('does NOT fire the idle watchdog when chunks arrive normally', async () => {
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

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'chat', id: 'normal1', payload: CHAT_PAYLOAD });

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done'));
    // Advance timers to confirm no delayed error fires.
    await vi.advanceTimersByTimeAsync(62_000);
    const errors = handlers.messages.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(0);
  });
});
