/**
 * Error-UX tests for ChatSession (fix/ux-session-error).
 *
 * (A) A failed turn is surfaced inline in the transcript (a synthetic
 *     skald_error assistant message), not only via onError → status row.
 * (B) The transport `retryable` flag is threaded through to onError AND
 *     the inline block, and resendLast() re-dispatches the last user turn.
 *
 * Node-env testable: pure session logic. The view rendering of the inline
 * block + Resend button is covered by CDP/on-device, not fabricated here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, Message } from './protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';

interface RecordingTransport {
  send: (msg: ClientMessage) => void;
  sent: ClientMessage[];
}
function recordingTransport(): RecordingTransport {
  const sent: ClientMessage[] = [];
  return { send: (msg) => { sent.push(msg); }, sent };
}
function makeHandlers(): ChatSessionHandlers {
  return { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() };
}
function newSession(tx: RecordingTransport, handlers: ChatSessionHandlers): ChatSession {
  return new ChatSession(
    tx as unknown as import('./transport-interface').SkaldTransport,
    () => 'claude-sonnet-4-6',
    async () => undefined,
    () => ({ provider: 'anthropic' }),
    () => [],
    async () => ({ content: 'ok' }),
    handlers,
  );
}
function lastChatId(tx: RecordingTransport): string {
  const m = tx.sent[tx.sent.length - 1];
  if (m.type !== 'chat') throw new Error('not chat');
  return m.id;
}
function errorBlocks(session: ChatSession): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of session.getMessages()) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b.type === 'skald_error') out.push(b);
      }
    }
  }
  return out;
}

describe('ChatSession (A): failed turn surfaced inline in the transcript', () => {
  it('pushes a skald_error assistant message on a transport error', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = newSession(tx, handlers);
    await session.sendUserText('hello');
    const id = lastChatId(tx);

    session.handleServer({ type: 'error', id, error: 'invalid x-api-key', retryable: false });

    const blocks = errorBlocks(session);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('invalid x-api-key');
    // inFlight cleared so the composer can unlock / a new turn can start.
    expect(session.getInFlight()).toBeNull();
    // onError still fires (status row + composer-unlock path preserved).
    expect(handlers.onError).toHaveBeenCalledWith('invalid x-api-key', { retryable: false });
  });

  it('also surfaces dispatch-time failures (system prompt) inline', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = new ChatSession(
      tx as unknown as import('./transport-interface').SkaldTransport,
      () => 'claude-sonnet-4-6',
      async () => { throw new Error('vault read failed'); },
      () => ({ provider: 'anthropic' }),
      () => [],
      async () => ({ content: 'ok' }),
      handlers,
    );
    await session.sendUserText('hi');
    const blocks = errorBlocks(session);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('vault read failed');
    expect(blocks[0].retryable).toBe(false);
  });
});

describe('ChatSession (B): retryable flag threaded + resend', () => {
  it('marks a retryable transport error retryable on onError and the block', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = newSession(tx, handlers);
    await session.sendUserText('hello');
    const id = lastChatId(tx);

    session.handleServer({ type: 'error', id, error: 'overloaded', retryable: true });

    expect(handlers.onError).toHaveBeenCalledWith('overloaded', { retryable: true });
    expect(errorBlocks(session)[0].retryable).toBe(true);
  });

  it('defaults retryable to false when the transport omits the flag', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = newSession(tx, handlers);
    await session.sendUserText('hello');
    session.handleServer({ type: 'error', id: lastChatId(tx), error: 'boom' });
    expect(handlers.onError).toHaveBeenCalledWith('boom', { retryable: false });
    expect(errorBlocks(session)[0].retryable).toBe(false);
  });

  it('resendLast re-dispatches the last user turn and drops the error block', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = newSession(tx, handlers);
    await session.sendUserText('hello');
    expect(tx.sent).toHaveLength(1);
    session.handleServer({ type: 'error', id: lastChatId(tx), error: 'overloaded', retryable: true });
    expect(errorBlocks(session)).toHaveLength(1);

    const started = await session.resendLast();
    expect(started).toBe(true);
    // A second chat request was dispatched.
    expect(tx.sent).toHaveLength(2);
    // The inline error block is gone; the user turn remains.
    expect(errorBlocks(session)).toHaveLength(0);
    const msgs = session.getMessages();
    expect(msgs.filter((m: Message) => m.role === 'user')).toHaveLength(1);
  });

  it('resendLast is a no-op when a turn is in flight', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = newSession(tx, handlers);
    await session.sendUserText('hello'); // turn now in flight (no done/error)
    expect(session.isInFlight()).toBe(true);
    const started = await session.resendLast();
    expect(started).toBe(false);
    expect(tx.sent).toHaveLength(1);
  });

  it('resendLast is a no-op when there is no user turn', async () => {
    const tx = recordingTransport();
    const session = newSession(tx, makeHandlers());
    const started = await session.resendLast();
    expect(started).toBe(false);
    expect(tx.sent).toHaveLength(0);
  });
});

describe('ChatSession: skald_error blocks never reach the provider', () => {
  it('strips error messages from a re-dispatched payload', async () => {
    const tx = recordingTransport();
    const session = newSession(tx, makeHandlers());
    await session.sendUserText('hello');
    session.handleServer({ type: 'error', id: lastChatId(tx), error: 'overloaded', retryable: true });
    await session.resendLast();

    const payload = (tx.sent[1] as Extract<ClientMessage, { type: 'chat' }>).payload;
    const hasErrorBlock = payload.messages.some(
      (m) => Array.isArray(m.content) &&
        m.content.some((b) => (b as Record<string, unknown>).type === 'skald_error'),
    );
    expect(hasErrorBlock).toBe(false);
    // The user turn is still present in the outgoing payload.
    expect(payload.messages.some((m) => m.role === 'user')).toBe(true);
  });
});
