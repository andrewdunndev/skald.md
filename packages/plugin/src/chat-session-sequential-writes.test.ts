/**
 * Sequential-write guarantee for ChatSession.executeToolsAndContinue.
 *
 * Read-only tools run in parallel (Promise.all); WRITE tools must run
 * strictly one-at-a-time so their approval UIs never overlap. The
 * existing integration suite only ever exercises a single write, so it
 * cannot catch a regression to Promise.all over writes. This file uses
 * a turn with TWO writes and a deferred first write to prove the second
 * executor is not invoked until the first resolves.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@scribian/protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';

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
  if (m.type !== 'chat') throw new Error(`message ${ix} is not a chat`);
  return m.id;
}

/** Inject a tool_use assistant turn + a server done(tool_use). */
async function injectToolTurn(
  session: ChatSession,
  tx: RecordingTransport,
  tools: { id: string; name: string }[],
): Promise<void> {
  await Promise.resolve();
  const mid = chatId(tx);
  tools.forEach(({ id, name }, idx) => {
    session.handleServer({ type: 'chunk', id: mid, event: 'content_block_start',
      data: { index: idx, content_block: { type: 'tool_use', id, name, input: {} } } });
    session.handleServer({ type: 'chunk', id: mid, event: 'content_block_stop',
      data: { index: idx } });
  });
  session.handleServer({ type: 'done', id: mid, stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 5 } });
}

describe('ChatSession.executeToolsAndContinue: writes stay sequential', () => {
  it('does not start the second write until the first resolves', async () => {
    const started: string[] = [];
    const finished: string[] = [];

    // The first write blocks on a manually-resolved deferred so we can
    // observe whether the second write starts while the first is pending.
    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((res) => { releaseFirst = res; });

    const tx = recordingTransport();
    const handlers: ChatSessionHandlers = {
      onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn(),
    };
    const session = new ChatSession(
      tx as unknown as import('./transport').Transport,
      () => 'claude-sonnet-4-6',
      async () => undefined,
      () => ({ provider: 'anthropic' }),
      () => [],
      async (_name, _input, id) => {
        started.push(id);
        if (id === 'w1') await firstDone; // block until released
        finished.push(id);
        return { content: 'ok' };
      },
      handlers,
    );

    void session.sendUserText('do two writes');
    // write_note is a write tool → routed to the sequential loop.
    await injectToolTurn(session, tx, [
      { id: 'w1', name: 'write_note' },
      { id: 'w2', name: 'write_note' },
    ]);

    // Let microtasks run: the first write starts and awaits firstDone.
    await Promise.resolve();
    await Promise.resolve();

    // First write is in flight; the second MUST NOT have started yet.
    // Passes on correct (sequential) code; FAILS under mutation
    // "writes run via Promise.all" — there w2 would also be started.
    expect(started).toEqual(['w1']);
    expect(finished).toEqual([]);

    // Release the first write; the second may now proceed.
    releaseFirst();
    for (let i = 0; i < 10 && tx.sent.length < 2; i++) await Promise.resolve();

    expect(started).toEqual(['w1', 'w2']);
    expect(finished).toEqual(['w1', 'w2']);
    // Second turn dispatched only after both writes finished.
    expect(tx.sent.length).toBe(2);
  });
});
