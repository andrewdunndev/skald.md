/**
 * Error-path tests for ChatSession — Fix 3 and Fix 4.
 *
 * Fix 3: a thrown write-tool executor must surface an is_error tool_result
 * (not an orphaned tool_use / leaked rejection).
 *
 * Fix 4: a systemProvider that throws must clear inFlight and call onError
 * so the composer unlocks, not leave the session stuck mid-dispatch.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ToolDefinition } from '@skald/protocol';
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
  if (m.type !== 'chat') throw new Error('not chat');
  return m.id;
}
function makeHandlers(): ChatSessionHandlers {
  return { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() };
}

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

async function waitForDispatches(tx: RecordingTransport, count: number): Promise<void> {
  for (let i = 0; i < 15 && tx.sent.length < count; i++) await Promise.resolve();
}

function getToolResults(session: ChatSession): Record<string, unknown>[] {
  for (const m of session.getMessages()) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      const bs = m.content as Record<string, unknown>[];
      if (bs.some((b) => b.type === 'tool_result')) return bs;
    }
  }
  return [];
}

describe('ChatSession Fix 3: thrown write executor emits is_error tool_result', () => {
  it('surfaces is_error block instead of orphaning the tool_use', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = new ChatSession(
      tx as unknown as import('./transport-interface').SkaldTransport,
      () => 'claude-sonnet-4-6',
      async () => undefined,
      () => ({ provider: 'anthropic' }),
      () => [],
      async (_name, _input, id) => {
        if (id === 'bad-write') throw new Error('disk full');
        return { content: 'ok' };
      },
      handlers,
    );
    void session.sendUserText('do a write');
    await injectToolTurn(session, tx, [{ id: 'bad-write', name: 'write_note' }]);
    await waitForDispatches(tx, 2);
    const results = getToolResults(session);
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.is_error).toBe(true);
    expect(typeof r.content).toBe('string');
    expect(r.content).toContain('disk full');
  });

  it('second write proceeds after first throws', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const called: string[] = [];
    const session = new ChatSession(
      tx as unknown as import('./transport-interface').SkaldTransport,
      () => 'claude-sonnet-4-6',
      async () => undefined,
      () => ({ provider: 'anthropic' }),
      () => [],
      async (_name, _input, id) => {
        called.push(id);
        if (id === 'w1') throw new Error('boom');
        return { content: 'done' };
      },
      handlers,
    );
    void session.sendUserText('two writes');
    await injectToolTurn(session, tx, [
      { id: 'w1', name: 'write_note' },
      { id: 'w2', name: 'write_note' },
    ]);
    await waitForDispatches(tx, 2);
    expect(called).toEqual(['w1', 'w2']);
    const results = getToolResults(session);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.tool_use_id === 'w1')?.is_error).toBe(true);
    expect(results.find((r) => r.tool_use_id === 'w2')?.is_error).toBeUndefined();
  });
});

describe('ChatSession Fix 4: systemProvider throw clears inFlight', () => {
  it('clears inFlight and calls onError when systemProvider rejects', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = new ChatSession(
      tx as unknown as import('./transport-interface').SkaldTransport,
      () => 'claude-sonnet-4-6',
      async () => { throw new Error('vault read failed'); },
      () => ({ provider: 'anthropic' }),
      () => [] as ToolDefinition[],
      async () => ({ content: 'x' }),
      handlers,
    );
    await session.sendUserText('hi');
    // inFlight must be null so a new turn can start.
    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect((handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('vault read failed');
    // transport.send must NOT have been called (no message dispatched).
    expect(tx.sent).toHaveLength(0);
  });
});
