/**
 * DirectTransport behavior tests. Uses mocked fetch returning ReadableStream
 * to exercise the happy path, cancel mid-stream, HTTP 401 error mapping,
 * and OpenRouter dispatch without real network I/O.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from '@scribian/protocol';
import { DirectTransport } from './direct-transport';

// ── helpers ───────────────────────────────────────────────────────────────

function makeHandlers() {
  const messages: ServerMessage[] = [];
  return {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn((m: ServerMessage) => messages.push(m)),
    onError: vi.fn(),
    messages,
  };
}

/** Build a ReadableStream that emits the given SSE chunks sequentially. */
function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** A minimal Response object that looks like a streaming 200. */
function ok200(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200 });
}

/** A 4xx response with a plain-text body. */
function errResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const ANTHROPIC_KEY = 'sk-ant-test';

function makeTransport(opts?: {
  anthropicKey?: string;
  openrouterKey?: string;
}) {
  const handlers = makeHandlers();
  const transport = new DirectTransport(
    {
      getAnthropicKey: () => opts?.anthropicKey ?? ANTHROPIC_KEY,
      getOpenRouterKey: () => opts?.openrouterKey ?? '',
    },
    handlers,
  );
  return { transport, handlers };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('DirectTransport.connect / isOpen / close', () => {
  it('fires onOpen synchronously on connect()', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(transport.isOpen()).toBe(true);
  });

  it('is not open before connect()', () => {
    const { transport } = makeTransport();
    expect(transport.isOpen()).toBe(false);
  });

  it('fires onClose and becomes closed after close()', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.close();
    expect(transport.isOpen()).toBe(false);
    expect(handlers.onClose).toHaveBeenCalledWith(1000, 'closed');
  });
});

describe('DirectTransport.send: echo / ping', () => {
  it('echo → echoed (synchronous)', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'echo', id: 'e1', text: 'hello' });
    expect(handlers.onMessage).toHaveBeenCalledOnce();
    const msg = handlers.messages[0];
    expect(msg.type).toBe('echoed');
    if (msg.type === 'echoed') {
      expect(msg.id).toBe('e1');
      expect(msg.text).toBe('hello');
    }
  });

  it('ping → pong (synchronous)', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({ type: 'ping' });
    expect(handlers.messages[0]).toEqual({ type: 'pong' });
  });
});

describe('DirectTransport: happy path streaming', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits chunk frames then a done frame on a clean stream', async () => {
    const sseChunk =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    fetchMock.mockResolvedValue(ok200(sseStream(sseChunk)));

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'turn1',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1024,
      },
    });

    // Wait for all microtasks to flush (stream pumping is async).
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done'));

    const chunks = handlers.messages.filter((m) => m.type === 'chunk');
    expect(chunks.length).toBeGreaterThan(0);

    const done = handlers.messages.find((m) => m.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.stop_reason).toBe('end_turn');
      expect(done.provider).toBe('anthropic');
      expect(done.usage.output_tokens).toBe(5);
    }
  });

  it('uses x-api-key for Anthropic and sets dangerous-direct-browser-access', async () => {
    fetchMock.mockResolvedValue(ok200(sseStream(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    )));

    const { transport } = makeTransport({ anthropicKey: 'sk-ant-123' });
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'turn1',
      payload: {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});

describe('DirectTransport: HTTP error mapping', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits error frame for HTTP 401', async () => {
    fetchMock.mockResolvedValue(errResponse(401, '{"type":"error","error":{"type":"authentication_error"}}'));

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'turn1',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.error).toContain('401');
      expect(err.retryable).toBe(false);
    }
  });

  it('marks 429 / 5xx as retryable', async () => {
    fetchMock.mockResolvedValue(errResponse(429, 'rate limited'));

    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'turn1',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    if (err?.type === 'error') {
      expect(err.retryable).toBe(true);
    }
  });

  it('emits non-retryable error and does NOT call fetch when Anthropic key is empty', async () => {
    const { transport, handlers } = makeTransport({ anthropicKey: '' });
    transport.connect();
    transport.send({ type: 'chat', id: 't1',
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 } });
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.error).toMatch(/anthropic api key/i);
      expect(err.error).toMatch(/settings/i);
      expect(err.retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits non-retryable error and does NOT call fetch when OpenRouter key is empty', async () => {
    const { transport, handlers } = makeTransport({ openrouterKey: '' });
    transport.connect();
    transport.send({ type: 'chat', id: 't2', provider: 'openrouter',
      payload: { model: 'anthropic/claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 } });
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.error).toMatch(/openrouter api key/i);
      expect(err.error).toMatch(/settings/i);
      expect(err.retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DirectTransport: cancel mid-stream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits done(cancelled) when fetch itself is aborted', async () => {
    // Simulate an AbortError thrown by fetch when the signal fires.
    // In the real browser/Electron, aborting the signal while fetch is
    // in-flight causes it to reject with an AbortError. We model that
    // directly here since JSDOM's ReadableStream doesn't propagate the
    // signal into reader.read() automatically.
    let resolveAbort!: () => void;
    const abortGate = new Promise<void>((r) => { resolveAbort = r; });

    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      // Return a promise that rejects with AbortError when abort fires.
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          resolveAbort();
        });
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

    // Wait for fetch to be called so the AbortController is registered.
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

describe('DirectTransport: OpenRouter dispatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('routes to OpenRouter URL with Bearer auth when provider=openrouter', async () => {
    fetchMock.mockResolvedValue(ok200(sseStream(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    )));

    const { transport } = makeTransport({ openrouterKey: 'or-test-key' });
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'or-turn',
      provider: 'openrouter',
      payload: {
        model: 'anthropic/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer or-test-key');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('rewrites Anthropic server tool types to openrouter:* for OpenRouter', async () => {
    fetchMock.mockResolvedValue(ok200(sseStream(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    )));

    const { transport } = makeTransport({ openrouterKey: 'or-test' });
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'or-tools',
      provider: 'openrouter',
      payload: {
        model: 'anthropic/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        ],
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });
});
