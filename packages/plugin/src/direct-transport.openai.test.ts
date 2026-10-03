/**
 * DirectTransport OpenAI end-to-end streaming tests.
 *
 * REAL bytes through SSEParser → pumpStream → makeOpenAiStreamTranslator.
 * This is the safety net for the eventless-data-frame bug: OpenAI SSE frames
 * carry NO `event:` field, so a parser that drops eventless frames returns
 * NOTHING for the whole stream (the OpenAI provider is dead end-to-end).
 *
 * These tests feed actual OpenAI-shaped SSE byte chunks (including a frame
 * split across a chunk boundary) and assert that content arrives, a mid-stream
 * error surfaces, and the done frame is well-formed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from './protocol';
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
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function ok200(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200 });
}

describe('DirectTransport: OpenAI streaming (eventless data frames)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function makeOpenAiTransport() {
    const handlers = makeHandlers();
    const transport = new DirectTransport(
      {
        getAnthropicKey: () => '',
        getOpenRouterKey: () => '',
        getOpenAiKey: () => 'sk-oai-test',
        getThinkingEnabled: () => false,
      },
      handlers,
    );
    return { transport, handlers };
  }

  function sendOpenAiChat(transport: DirectTransport) {
    transport.connect();
    transport.send({
      type: 'chat',
      id: 'oai-turn',
      provider: 'openai',
      openai_base_url: 'https://api.openai.com/v1',
      payload: {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 256,
      },
    });
  }

  it('translates a clean OpenAI stream: text chunks → content, then done', async () => {
    // Real OpenAI SSE shape — `data:` only, NO `event:` field. A frame is split
    // across two byte chunks to also exercise the parser boundary handling.
    fetchMock.mockResolvedValue(ok200(sseStream(
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    )));

    const { transport, handlers } = makeOpenAiTransport();
    sendOpenAiChat(transport);

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done'));

    // Content actually arrived (the whole point — eventless frames not dropped).
    const textDeltas = handlers.messages
      .filter((m) => m.type === 'chunk')
      .map((m) => m as Extract<ServerMessage, { type: 'chunk' }>)
      .filter((m) => m.event === 'content_block_delta')
      .map((m) => ((m.data as any)?.delta?.text as string) ?? '')
      .join('');
    expect(textDeltas).toBe('Hello');

    // Non-empty, well-formed done with mapped stop_reason + usage.
    const done = handlers.messages.find((m) => m.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.provider).toBe('openai');
      expect(done.stop_reason).toBe('end_turn');
      expect(done.usage.input_tokens).toBe(7);
      expect(done.usage.output_tokens).toBe(2);
    }
  });

  it('surfaces a mid-stream eventless error frame as an error chunk', async () => {
    fetchMock.mockResolvedValue(ok200(sseStream(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"server overloaded","type":"server_error"}}\n\n',
    )));

    const { transport, handlers } = makeOpenAiTransport();
    sendOpenAiChat(transport);

    await vi.waitUntil(() => handlers.messages.some((m) => m.type === 'done'));

    const errChunk = handlers.messages
      .filter((m) => m.type === 'chunk')
      .map((m) => m as Extract<ServerMessage, { type: 'chunk' }>)
      .find((m) => m.event === 'error');
    expect(errChunk).toBeDefined();
    expect((errChunk!.data as any).message).toBe('server overloaded');
  });

  it('sends max_completion_tokens (not max_tokens) in the OpenAI request body', async () => {
    fetchMock.mockResolvedValue(ok200(sseStream('data: [DONE]\n\n')));

    const { transport } = makeOpenAiTransport();
    sendOpenAiChat(transport);

    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
  });
});
