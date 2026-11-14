/**
 * DirectTransport cancellation tests. Split out of direct-transport.test.ts
 * (single responsibility: abort handling) to keep both files under the
 * size cap. Covers the two distinct abort sites:
 *   - fetch itself rejects with AbortError (pre-stream, runChat's catch)
 *   - the in-flight reader.read() rejects mid-pump (pumpStream's catch)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from './protocol';
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

function ok200(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200 });
}

describe('DirectTransport: cancel before the stream opens', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits done(cancelled) when fetch itself is aborted', async () => {
    // In the real browser, aborting while fetch is in-flight rejects it
    // with an AbortError. JSDOM doesn't propagate the signal into the
    // promise automatically, so model that directly here.
    let resolveAbort!: () => void;
    const abortGate = new Promise<void>((r) => { resolveAbort = r; });

    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        const fail = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          resolveAbort();
        };
        if (signal.aborted) return fail();
        signal.addEventListener('abort', fail);
      });
    });

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'cancel-me',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    transport.send({ type: 'cancel', id: 'cancel-me' });
    await abortGate;

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done'));
    const done = handlers.messages.find((m) => m.type === 'done');
    if (done?.type === 'done') {
      expect(done.stop_reason).toBe('cancelled');
    }
  });
});

describe('DirectTransport: cancel mid-pump', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits done(cancelled) when aborted during reader.read()', async () => {
    // 200 already returned; the stream is open but idle when abort fires.
    // The pending reader.read() rejects with an AbortError, exercising
    // pumpStream's catch rather than runChat's.
    let abortStream!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        abortStream = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          controller.error(err);
        };
        // Never enqueue/close on its own — stays pending until aborted.
      },
    });

    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => abortStream());
      return Promise.resolve(ok200(stream));
    });

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'pump-cancel',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    transport.send({ type: 'cancel', id: 'pump-cancel' });

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done'));
    const done = handlers.messages.find((m) => m.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.stop_reason).toBe('cancelled');
      expect(done.provider).toBe('anthropic');
    }
  });
});

describe('DirectTransport: error body handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const payload = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user' as const, content: 'hi' }],
    max_tokens: 100,
  };

  it('Stop aborts a stalled error body and ends with done(cancelled)', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        fetchMock.mockImplementation((_u: string, init: RequestInit) => {
          (init.signal as AbortSignal).addEventListener('abort', () =>
            c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
          return Promise.resolve(new Response(stalled, { status: 500 }));
        });
      },
    });
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'chat', id: 'err-stop', payload });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    transport.send({ type: 'cancel', id: 'err-stop' });

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done' || m.type === 'error'));
    const done = handlers.messages.find((m) => m.type === 'done');
    expect(done?.type === 'done' && done.stop_reason).toBe('cancelled');
    expect(handlers.messages.some((m) => m.type === 'error')).toBe(false);
  });

  it('surfaces a plain string error field from the provider body', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"model \\"x\\" not found"}', { status: 404 }));
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'chat', id: 'err-str', payload });
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    expect(err?.type === 'error' && err.error).toContain('(model "x" not found)');
  });
});
