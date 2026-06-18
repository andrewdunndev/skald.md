import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from '@scribian/protocol';
import { DirectTransport } from './direct-transport';

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

function ok200(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200 });
}
function errResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const ANTHROPIC_KEY = 'sk-ant-test';
function makeTransport(opts?: {
  anthropicKey?: string;
  openrouterKey?: string;
  thinkingEnabled?: boolean;
}) {
  const handlers = makeHandlers();
  const transport = new DirectTransport(
    {
      getAnthropicKey: () => opts?.anthropicKey ?? ANTHROPIC_KEY,
      getOpenRouterKey: () => opts?.openrouterKey ?? '',
      getThinkingEnabled: () => opts?.thinkingEnabled ?? false,
    },
    handlers,
  );
  return { transport, handlers };
}

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

  it('puts cache_control on system + last tool in the Anthropic request body', async () => {
    fetchMock.mockResolvedValue(ok200(sseStream(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    )));

    const { transport } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'cache-turn',
      payload: {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        system: 'You are a vault assistant.',
        tools: [
          { name: 'read_note', input_schema: {} },
          { name: 'write_note', input_schema: {} },
        ],
      },
    });

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // Prompt caching is GA — the stale beta header must NOT be sent (Fix 5).
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBeUndefined();

    // system is restructured into a text-block array with an ephemeral
    // breakpoint, and the LAST tool carries one too.
    const body = JSON.parse(init.body as string);
    expect(body.system[0].cache_control.type).toBe('ephemeral');
    expect(body.system[0].text).toBe('You are a vault assistant.');
    expect(body.tools[body.tools.length - 1].cache_control.type).toBe('ephemeral');
    // The non-final tool stays untouched (single breakpoint).
    expect(body.tools[0].cache_control).toBeUndefined();
  });
});

describe('DirectTransport: HTTP error mapping', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('emits a friendly non-retryable error for HTTP 401 — no raw JSON, no status dump', async () => {
    fetchMock.mockResolvedValue(errResponse(401, '{"type":"error","error":{"type":"authentication_error"}}'));
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 't',
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
    });
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      // Human copy — mentions settings, no raw JSON or status codes.
      expect(err.error).toMatch(/api key/i);
      expect(err.error).toMatch(/settings/i);
      expect(err.error).not.toContain('authentication_error');
      expect(err.retryable).toBe(false);
    }
  });

  // 403/400/5xx mapping is unit-tested in direct-transport-errors.test.ts;
  // these prove the transport surfaces friendly copy, strips the raw body
  // (401), and threads retry-after (429).

  it('emits a friendly, retryable 429 message with retry-after, no raw JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
        status: 429,
        headers: { 'retry-after': '12' },
      }),
    );
    const { transport, handlers } = makeTransport();
    transport.connect();
    transport.send({
      type: 'chat',
      id: 't',
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
    });
    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'error'));
    const err = handlers.messages.find((m) => m.type === 'error');
    if (err?.type === 'error') {
      expect(err.retryable).toBe(true);
      expect(err.error).toContain('Rate limit reached');
      expect(err.error).toContain('retry in 12s');
      expect(err.error).not.toContain('rate_limit_error'); // no raw JSON
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

describe('DirectTransport: extended thinking (deep mode)', () => {
  const MINIMAL_SSE =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  async function sendChat(
    opts: { thinkingEnabled?: boolean; provider?: 'openrouter'; openrouterKey?: string },
  ) {
    fetchMock.mockResolvedValue(ok200(sseStream(MINIMAL_SSE)));
    const { transport } = makeTransport({
      thinkingEnabled: opts.thinkingEnabled ?? false,
      openrouterKey: opts.openrouterKey,
    });
    transport.connect();
    transport.send({
      type: 'chat', id: 'th', provider: opts.provider,
      payload: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 },
    });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    return JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
  }

  it('sends thinking + bumps max_tokens above the budget on Anthropic (Fix 1)', async () => {
    // 4096 default < 8192 budget → 400 unless max_tokens > budget (budget+4096).
    const body = await sendChat({ thinkingEnabled: true });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
    expect(body.max_tokens).toBe(8192 + 4096);
  });

  it('omits thinking and leaves max_tokens (1024) unchanged when off (Fix 1)', async () => {
    const body = await sendChat({ thinkingEnabled: false });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(1024);
  });

  it('does NOT send thinking param to OpenRouter even when thinkingEnabled=true', async () => {
    const body = await sendChat({ thinkingEnabled: true, provider: 'openrouter', openrouterKey: 'or-key' });
    expect(body.thinking).toBeUndefined();
  });
});
