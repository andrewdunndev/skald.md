/**
 * Tests for the agentic tool-loop leg cap (MAX_TOOL_LEGS).
 *
 * The agentic tool loop (model calls tool → result fed back → model calls
 * another tool → …) has no inherent limit, so a misbehaving model can burn
 * tokens without bound. MAX_TOOL_LEGS caps how many consecutive tool-execution
 * legs a single user turn may execute. On hitting the cap the loop stops and
 * a user-facing notice is surfaced via onError; the session is left unlocked
 * (inFlight === null) so the composer can accept a new turn.
 *
 * The suite also confirms that:
 *   - short loops (1–5 legs) complete normally and call onDone
 *   - the counter resets between user turns (a second turn gets a fresh cap)
 *   - the notice appears on exactly the 20th leg, not the 19th or 21st
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '@skald/protocol';
import {
  ChatSession,
  MAX_TOOL_LEGS,
  type ChatSessionHandlers,
} from './chat-session';
import type { SkaldTransport } from './transport-interface';

// ---------------------------------------------------------------------------
// Test infrastructure shared across this file
// ---------------------------------------------------------------------------

interface RecordingTransport {
  send: (msg: ClientMessage) => void;
  sent: ClientMessage[];
}

function recordingTransport(): RecordingTransport {
  const sent: ClientMessage[] = [];
  return { send: (msg) => { sent.push(msg); }, sent };
}

function chatId(tx: RecordingTransport, ix = tx.sent.length - 1): string {
  const m = tx.sent[ix];
  if (m.type !== 'chat') throw new Error(`sent[${ix}] is not a chat`);
  return m.id;
}

function makeHandlers(): ChatSessionHandlers {
  return { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() };
}

function makeSession(
  tx: RecordingTransport,
  handlers: ChatSessionHandlers,
): ChatSession {
  return new ChatSession(
    tx as unknown as SkaldTransport,
    () => 'claude-sonnet-4-6',
    async () => undefined,
    () => ({ provider: 'anthropic' as const }),
    () => [],
    async () => ({ content: 'tool result' }),
    handlers,
  );
}

/**
 * Inject one tool_use assistant response + done(tool_use) against the most
 * recently dispatched chat request. Awaits at least one microtask tick first
 * to let dispatch()'s async systemProvider complete.
 */
async function injectToolLeg(
  session: ChatSession,
  tx: RecordingTransport,
  toolId: string,
): Promise<void> {
  // Flush so dispatch() has completed its async systemProvider await.
  await Promise.resolve();
  const mid = chatId(tx);
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_start',
    data: { index: 0, content_block: { type: 'tool_use', id: toolId, name: 'read_note', input: {} } },
  });
  session.handleServer({ type: 'chunk', id: mid, event: 'content_block_stop', data: { index: 0 } });
  session.handleServer({
    type: 'done', id: mid, stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 5 },
  } as ServerMessage);
}

/**
 * Inject a normal end_turn response against the most recent chat request.
 */
async function injectEndTurn(
  session: ChatSession,
  tx: RecordingTransport,
): Promise<void> {
  await Promise.resolve();
  const mid = chatId(tx);
  session.handleServer({
    type: 'done', id: mid, stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  } as ServerMessage);
}

/**
 * Run microtask flushes until the transport has at least `count` sent
 * messages. We drain up to `maxFlushes` ticks to avoid an infinite loop.
 */
async function drainUntil(
  tx: RecordingTransport,
  count: number,
  maxFlushes = 30,
): Promise<void> {
  for (let i = 0; i < maxFlushes && tx.sent.length < count; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Sanity: constant is exported and has the expected value
// ---------------------------------------------------------------------------

describe('MAX_TOOL_LEGS constant', () => {
  it('equals 20', () => {
    expect(MAX_TOOL_LEGS).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Normal short loops still work
// ---------------------------------------------------------------------------

describe('short tool loops complete normally', () => {
  it('a single tool leg resolves and calls onDone', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('question');
    await injectToolLeg(session, tx, 'tu-1');
    await drainUntil(tx, 2); // second dispatch expected
    await injectEndTurn(session, tx);
    await drainUntil(tx, 2);
    // Give finalize() time to complete.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledOnce();
    expect(session.getInFlight()).toBeNull();
  });

  it('five consecutive tool legs resolve and call onDone', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('question');
    for (let leg = 1; leg <= 5; leg++) {
      await drainUntil(tx, leg); // wait for dispatch N
      await injectToolLeg(session, tx, `tu-${leg}`);
      await drainUntil(tx, leg + 1); // wait for dispatch N+1
    }
    await injectEndTurn(session, tx);
    for (let i = 0; i < 15; i++) await Promise.resolve();

    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledOnce();
    expect(session.getInFlight()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cap fires at exactly MAX_TOOL_LEGS and not before
// ---------------------------------------------------------------------------

describe('agentic leg cap: halts at MAX_TOOL_LEGS', () => {
  /**
   * Drive exactly `legCount` tool_use → done(tool_use) legs.
   * Returns the harness so callers can inspect handlers/tx.
   */
  async function driveLegs(legCount: number): Promise<{
    tx: RecordingTransport;
    handlers: ChatSessionHandlers;
    session: ChatSession;
  }> {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('question');
    for (let leg = 1; leg <= legCount; leg++) {
      await drainUntil(tx, leg);
      await injectToolLeg(session, tx, `tu-${leg}`);
      // After the cap fires, no further dispatch occurs — stop waiting.
      if ((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length > 0) break;
      await drainUntil(tx, leg + 1);
    }
    // Final flush to let finalize() settle.
    for (let i = 0; i < 15; i++) await Promise.resolve();
    return { tx, handlers, session };
  }

  it('does NOT cap at 19 legs (one leg short of the limit)', async () => {
    const { handlers } = await driveLegs(MAX_TOOL_LEGS - 1);
    // 19 legs should not trigger the cap.
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('fires onError on the 20th leg with the cap notice', async () => {
    const { handlers, session } = await driveLegs(MAX_TOOL_LEGS);

    expect(handlers.onError).toHaveBeenCalledOnce();
    const msg = (handlers.onError as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain(`${MAX_TOOL_LEGS} tool steps`);
    // Session must be unlocked so the user can send a new message.
    expect(session.getInFlight()).toBeNull();
    // onDone must NOT have fired — the turn was interrupted.
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it('fires onError on the 20th leg when 25 legs are injected', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('question');
    let legsExecuted = 0;
    for (let leg = 1; leg <= 25; leg++) {
      await drainUntil(tx, leg);
      if ((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
        break;
      }
      await injectToolLeg(session, tx, `tu-${leg}`);
      legsExecuted++;
      if ((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length > 0) break;
      await drainUntil(tx, leg + 1);
    }
    for (let i = 0; i < 15; i++) await Promise.resolve();

    // Cap must fire exactly once, not multiple times.
    expect(handlers.onError).toHaveBeenCalledOnce();
    // Must have stopped at or before MAX_TOOL_LEGS.
    expect(legsExecuted).toBeLessThanOrEqual(MAX_TOOL_LEGS);
    // Session is unlocked.
    expect(session.getInFlight()).toBeNull();
  });

  it('does not dispatch a new leg after the cap fires', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('question');
    for (let leg = 1; leg <= MAX_TOOL_LEGS; leg++) {
      await drainUntil(tx, leg);
      await injectToolLeg(session, tx, `tu-${leg}`);
      if ((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length > 0) break;
      await drainUntil(tx, leg + 1);
    }
    // Capture the dispatch count right after the cap fires.
    const dispatchesAtCap = tx.sent.length;
    // Run many more ticks — if the loop were to continue, it would send more.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(tx.sent.length).toBe(dispatchesAtCap);
    expect(handlers.onError).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Counter resets between user turns
// ---------------------------------------------------------------------------

describe('leg counter resets per user turn', () => {
  it('allows another 20-leg budget on the next user turn after a capped turn', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    // First user turn: drive to the cap.
    void session.sendUserText('first question');
    for (let leg = 1; leg <= MAX_TOOL_LEGS; leg++) {
      await drainUntil(tx, leg);
      await injectToolLeg(session, tx, `t1-${leg}`);
      if ((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length > 0) break;
      await drainUntil(tx, leg + 1);
    }
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(session.getInFlight()).toBeNull();

    // Second user turn: should get a fresh MAX_TOOL_LEGS budget.
    const dispatchesBefore = tx.sent.length;
    void session.sendUserText('second question');
    // Drive 5 legs — should work without triggering the cap again.
    for (let leg = 1; leg <= 5; leg++) {
      await drainUntil(tx, dispatchesBefore + leg);
      await injectToolLeg(session, tx, `t2-${leg}`);
      if ((handlers.onError as ReturnType<typeof vi.fn>).mock.calls.length > 1) break;
      await drainUntil(tx, dispatchesBefore + leg + 1);
    }
    // End the second turn normally.
    await injectEndTurn(session, tx);
    for (let i = 0; i < 15; i++) await Promise.resolve();

    // Still only one error — the second turn did not re-trigger the cap.
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onDone).toHaveBeenCalledOnce();
  });
});
