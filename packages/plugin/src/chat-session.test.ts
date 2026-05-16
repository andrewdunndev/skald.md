/**
 * ChatSession integration tests. The missing middle layer of the
 * pyramid — unit tests cover the leaves (executor, summary,
 * mention extraction), and these cover the assembled chat
 * orchestration: what shape does the dispatched ClientMessage
 * actually take given different settings, picked attachments,
 * and tool-result sequences?
 *
 * The bugs this layer catches (vs unit tests): "memory tools
 * advertised when memory is disabled" would be caught by the
 * `payload.tools` shape assertion below. "Stale system prompt
 * after settings change" would be caught by the per-turn
 * re-read assertion. Each test names the exact shape the
 * dispatched message MUST take.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ChatRequest,
  ServerMessage,
  ToolDefinition,
} from '@scribian/protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';

interface RecordingTransport {
  send: (msg: ClientMessage) => void;
  sent: ClientMessage[];
}

function recordingTransport(): RecordingTransport {
  const sent: ClientMessage[] = [];
  return {
    send: (msg) => {
      sent.push(msg);
    },
    sent,
  };
}

interface HarnessOptions {
  model?: string;
  system?: string | undefined;
  tools?: ToolDefinition[];
  provider?: 'anthropic' | 'openrouter';
  apiKey?: string;
  toolExecutor?: (
    name: string,
    input: unknown,
    toolUseId: string,
  ) => Promise<{ content: string; is_error?: boolean }>;
}

function makeHarness(opts: HarnessOptions = {}) {
  const tx = recordingTransport();
  const handlers: ChatSessionHandlers = {
    onUpdate: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
  const session = new ChatSession(
    tx as unknown as import('./transport').Transport,
    () => opts.model ?? 'claude-sonnet-4-6',
    async () => opts.system,
    () => ({ provider: opts.provider ?? 'anthropic', apiKey: opts.apiKey }),
    () => opts.tools ?? [],
    opts.toolExecutor ??
      (async () => ({ content: 'stub tool result' })),
    handlers,
  );
  return { tx, session, handlers };
}

function lastPayload(tx: RecordingTransport): ChatRequest {
  const last = tx.sent[tx.sent.length - 1];
  if (last.type !== 'chat') {
    throw new Error(`last sent was not a chat message: ${last.type}`);
  }
  return last.payload;
}

/** Pull the chat-message id of the first sent message. The
 * ClientMessage union has several types without an `id` field
 * (`ping`); narrow before access. */
function chatId(tx: RecordingTransport, ix = 0): string {
  const m = tx.sent[ix];
  if (m.type !== 'chat') throw new Error(`message ${ix} is not a chat`);
  return m.id;
}

// Simulate the Worker's `done` ServerMessage shape so finalize()
// flushes the in-flight buffer + fires onDone.
function makeDoneMessage(id: string): ServerMessage {
  return {
    type: 'done',
    id,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

describe('ChatSession.dispatch: payload shape', () => {
  it('sends a chat message with model + messages + max_tokens', async () => {
    const { tx, session } = makeHarness({ model: 'claude-haiku-4-5' });
    await session.sendUserText('hello');
    expect(tx.sent).toHaveLength(1);
    const payload = lastPayload(tx);
    expect(payload.model).toBe('claude-haiku-4-5');
    expect(payload.max_tokens).toBe(4096);
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('includes system in payload when systemProvider returns a string', async () => {
    const { tx, session } = makeHarness({ system: 'You are an editor.' });
    await session.sendUserText('hi');
    expect(lastPayload(tx).system).toBe('You are an editor.');
  });

  it('omits system from payload when systemProvider returns undefined', async () => {
    const { tx, session } = makeHarness({ system: undefined });
    await session.sendUserText('hi');
    expect(lastPayload(tx).system).toBeUndefined();
  });

  it('re-reads system prompt on every turn (settings change applies immediately)', async () => {
    let current = 'PROMPT_A';
    const tx = recordingTransport();
    const handlers: ChatSessionHandlers = {
      onUpdate: vi.fn(),
      onError: vi.fn(),
      onDone: vi.fn(),
    };
    const session = new ChatSession(
      tx as unknown as import('./transport').Transport,
      () => 'claude-sonnet-4-6',
      async () => current,
      () => ({ provider: 'anthropic' }),
      () => [],
      async () => ({ content: 'x' }),
      handlers,
    );
    await session.sendUserText('first');
    // Simulate done so the session is ready for the next turn.
    session.handleServer(makeDoneMessage(chatId(tx)));
    current = 'PROMPT_B';
    await session.sendUserText('second');
    expect(lastPayload(tx).system).toBe('PROMPT_B');
  });

  it('re-reads tool definitions on every turn (memory-tool gate applies immediately)', async () => {
    let activeTools: ToolDefinition[] = [
      { name: 'read_note', input_schema: {} },
    ];
    const tx = recordingTransport();
    const session = new ChatSession(
      tx as unknown as import('./transport').Transport,
      () => 'claude-sonnet-4-6',
      async () => undefined,
      () => ({ provider: 'anthropic' }),
      () => activeTools,
      async () => ({ content: 'x' }),
      { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() },
    );
    await session.sendUserText('turn 1');
    expect(lastPayload(tx).tools).toEqual([
      { name: 'read_note', input_schema: {} },
    ]);
    session.handleServer(makeDoneMessage(chatId(tx)));
    activeTools = [
      { name: 'read_note', input_schema: {} },
      { name: 'remember_fact', input_schema: {} },
    ];
    await session.sendUserText('turn 2');
    const turn2Tools = (lastPayload(tx).tools as ToolDefinition[]) ?? [];
    expect(turn2Tools.map((t) => t.name)).toEqual([
      'read_note',
      'remember_fact',
    ]);
  });

  it('omits tools from payload entirely when toolDefinitionsProvider returns empty', async () => {
    const { tx, session } = makeHarness({ tools: [] });
    await session.sendUserText('hi');
    expect(lastPayload(tx).tools).toBeUndefined();
  });

  it('sets the wrapping provider + apiKey field for anthropic routes', async () => {
    const { tx, session } = makeHarness({
      provider: 'anthropic',
      apiKey: 'sk-ant-xxx',
    });
    await session.sendUserText('hi');
    const msg = tx.sent[0];
    if (msg.type !== 'chat') throw new Error('expected chat');
    expect(msg.provider).toBe('anthropic');
    expect(msg.anthropic_api_key).toBe('sk-ant-xxx');
    expect(msg.openrouter_api_key).toBeUndefined();
  });

  it('sets the wrapping provider + apiKey field for openrouter routes', async () => {
    const { tx, session } = makeHarness({
      provider: 'openrouter',
      apiKey: 'or-yyy',
    });
    await session.sendUserText('hi');
    const msg = tx.sent[0];
    if (msg.type !== 'chat') throw new Error('expected chat');
    expect(msg.provider).toBe('openrouter');
    expect(msg.openrouter_api_key).toBe('or-yyy');
    expect(msg.anthropic_api_key).toBeUndefined();
  });

  it('passes a multi-modal content-block array through the payload unchanged', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserMessage([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
      },
      { type: 'text', text: 'identify this' },
    ]);
    const payload = lastPayload(tx);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].role).toBe('user');
    expect(payload.messages[0].content).toHaveLength(2);
    expect(((payload.messages[0].content as any)[0] as any).type).toBe('image');
  });
});

describe('ChatSession.reset', () => {
  it('clears messages so the next dispatch ships a fresh history', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserText('turn 1');
    expect(lastPayload(tx).messages).toHaveLength(1);
    // Finalize the in-flight turn so a new one can start.
    session.handleServer(makeDoneMessage(chatId(tx)));
    session.reset();
    await session.sendUserText('fresh');
    expect(lastPayload(tx).messages).toEqual([
      { role: 'user', content: 'fresh' },
    ]);
  });

  it('zeroes totalUsage after reset', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserText('hi');
    session.handleServer(makeDoneMessage(chatId(tx)));
    // After done: totalUsage accumulated the turn's usage.
    expect(session.getTotalUsage().input_tokens).toBe(10);
    session.reset();
    expect(session.getTotalUsage()).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it('mints a new conversationId on reset (a new chat is a new conversation)', async () => {
    const { session } = makeHarness();
    const id1 = session.conversationId;
    session.reset();
    expect(session.conversationId).not.toBe(id1);
  });
});

describe('ChatSession.handleServer: error path', () => {
  it('clears the in-flight buffer on error so a new turn can start', async () => {
    const { tx, session, handlers } = makeHarness();
    await session.sendUserText('hi');
    expect(session.getInFlight()).not.toBeNull();
    session.handleServer({
      type: 'error',
      id: chatId(tx),
      error: 'upstream broke',
    });
    expect(session.getInFlight()).toBeNull();
    expect(handlers.onError).toHaveBeenCalledWith('upstream broke');
  });
});

describe('ChatSession.cancel', () => {
  it('sends a cancel message to the transport with the in-flight id', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserText('hi');
    const turnId = chatId(tx);
    session.cancel();
    expect(tx.sent).toHaveLength(2);
    const cancelMsg = tx.sent[1];
    expect(cancelMsg.type).toBe('cancel');
    if (cancelMsg.type === 'cancel') {
      expect(cancelMsg.id).toBe(turnId);
    }
  });

  it('is a no-op when no turn is in-flight', () => {
    const { tx, session } = makeHarness();
    session.cancel();
    expect(tx.sent).toHaveLength(0);
  });
});
