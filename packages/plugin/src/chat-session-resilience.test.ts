/**
 * Resilience tests for ChatSession — Fix A and Fix B.
 *
 * Fix A: an unhandled rejection from `void this.finalize()` (and from
 * buildDocumentBlock) must clear inFlight and surface via onError so the
 * composer unlocks. Also: a synchronous throw anywhere inside dispatch()
 * must do the same.
 *
 * Fix B: a mid-stream Anthropic SSE `error` event must surface via onError
 * and clear inFlight — not be silently dropped into a stuck "done" with no
 * error shown.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from './protocol';
import { ChatSession, type ChatSessionHandlers, type ProviderConfig } from './chat-session';
import type { SkaldTransport } from './transport-interface';

interface RecordingTransport {
  send: (msg: ClientMessage) => void;
  sent: ClientMessage[];
}
function recordingTransport(): RecordingTransport {
  const sent: ClientMessage[] = [];
  return { send: (msg) => { sent.push(msg); }, sent };
}
function chatId(tx: RecordingTransport, ix = 0): string {
  const m = tx.sent[ix];
  if (m.type !== 'chat') throw new Error('not chat');
  return m.id;
}
function makeHandlers(): ChatSessionHandlers {
  return { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() };
}
function makeSession(
  tx: RecordingTransport,
  handlers: ChatSessionHandlers,
  overrides?: Partial<{
    systemProvider: () => Promise<string | undefined>;
    modelProvider: () => string;
    providerConfigProvider: () => ProviderConfig;
  }>,
): ChatSession {
  return new ChatSession(
    tx as unknown as SkaldTransport,
    overrides?.modelProvider ?? (() => 'claude-sonnet-4-6'),
    overrides?.systemProvider ?? (async () => undefined),
    overrides?.providerConfigProvider ?? (() => ({ provider: 'anthropic' as const })),
    () => [],
    async () => ({ content: 'ok' }),
    handlers,
  );
}

// ---------------------------------------------------------------------------
// Fix A — dispatch() outer catch: synchronous throw clears busy state
// ---------------------------------------------------------------------------

describe('Fix A: dispatch outer catch clears inFlight on synchronous throw', () => {
  it('clears inFlight and calls onError when providerConfigProvider throws', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers, {
      providerConfigProvider: () => { throw new Error('config exploded'); },
    });
    await session.sendUserText('hi');
    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('config exploded');
    expect(tx.sent).toHaveLength(0);
  });

  it('clears inFlight and calls onError when modelProvider throws', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers, {
      modelProvider: () => { throw new Error('model lookup failed'); },
    });
    await session.sendUserText('hi');
    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('model lookup failed');
    expect(tx.sent).toHaveLength(0);
  });

  it('session is usable for a follow-up turn after dispatch throws', async () => {
    let shouldThrow = true;
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers, {
      modelProvider: () => {
        if (shouldThrow) throw new Error('temporary failure');
        return 'claude-sonnet-4-6';
      },
    });
    await session.sendUserText('first');
    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledOnce();

    shouldThrow = false;
    const errsBefore = (handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length;
    await session.sendUserText('retry');
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length).toBe(errsBefore);
    expect(tx.sent.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Fix A — finalize().catch: rejection inside continuation propagates via onError
// ---------------------------------------------------------------------------

describe('Fix A: finalize().catch() surfaces errors from continuation dispatch', () => {
  it('surfaces onError and clears inFlight when the continuation dispatch throws', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();

    // Override send so that the SECOND call (the tool-use continuation) throws.
    let sendCount = 0;
    const throwingTx: RecordingTransport = {
      sent: tx.sent,
      send: (msg) => {
        sendCount++;
        if (sendCount > 1) throw new Error('transport send failed on continuation');
        tx.send(msg);
      },
    };

    const session = makeSession(throwingTx, handlers);
    void session.sendUserText('go');
    await Promise.resolve();

    const mid = chatId(throwingTx);
    session.handleServer({
      type: 'chunk', id: mid, event: 'content_block_start',
      data: { index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'write_note', input: {} } },
    });
    session.handleServer({ type: 'chunk', id: mid, event: 'content_block_stop', data: { index: 0 } });
    session.handleServer({
      type: 'done', id: mid, stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalled();
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'transport send failed on continuation',
    );
  });
});

// ---------------------------------------------------------------------------
// Fix B — handleChunk 'error' event surfaces via onError
// ---------------------------------------------------------------------------

describe('Fix B: mid-stream SSE error event surfaces via onError', () => {
  it('calls onError with the provider error message from error.message', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);
    void session.sendUserText('hi');
    await Promise.resolve();

    const mid = chatId(tx);
    session.handleServer({
      type: 'chunk', id: mid, event: 'content_block_start',
      data: { index: 0, content_block: { type: 'text', text: '' } },
    });
    session.handleServer({
      type: 'chunk', id: mid, event: 'content_block_delta',
      data: { index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    });
    session.handleServer({
      type: 'chunk', id: mid, event: 'error',
      data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });

    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Overloaded');
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it('ignores a trailing done after an error event so the composer stays unlocked', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);
    void session.sendUserText('hi');
    await Promise.resolve();

    const mid = chatId(tx);
    session.handleServer({
      type: 'chunk', id: mid, event: 'error',
      data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    session.handleServer({
      type: 'done', id: mid, stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it('surfaces error from top-level message field when error.message absent', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);
    void session.sendUserText('hi');
    await Promise.resolve();

    const mid = chatId(tx);
    session.handleServer({
      type: 'chunk', id: mid, event: 'error',
      data: { type: 'error', message: 'Something went wrong' },
    });

    expect(handlers.onError).toHaveBeenCalledOnce();
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Something went wrong');
  });

  it('surfaces a fallback message when error data has no message fields', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);
    void session.sendUserText('hi');
    await Promise.resolve();

    const mid = chatId(tx);
    session.handleServer({
      type: 'chunk', id: mid, event: 'error',
      data: { type: 'error' },
    });

    expect(handlers.onError).toHaveBeenCalledOnce();
    const msg = (handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('session is unlocked for a new turn after an error event', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);
    void session.sendUserText('first');
    await Promise.resolve();

    const mid = chatId(tx);
    session.handleServer({
      type: 'chunk', id: mid, event: 'error',
      data: { type: 'error', error: { message: 'Rate limited' } },
    });

    const errCallsBefore = (handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length;
    await session.sendUserText('retry');
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length).toBe(errCallsBefore);
    expect(tx.sent.length).toBeGreaterThanOrEqual(2);
  });
});
