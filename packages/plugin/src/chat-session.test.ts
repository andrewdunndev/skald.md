/**
 * ChatSession integration tests. The missing middle layer of the
 * pyramid — unit tests cover the leaves (executor, summary,
 * mention extraction), and these cover the assembled chat
 * orchestration: what shape does the dispatched ClientMessage
 * actually take given different settings, picked attachments,
 * and tool-result sequences?
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ChatRequest,
  ServerMessage,
  ToolDefinition,
} from '@skald/protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';

interface RecordingTransport {
  send: (msg: ClientMessage) => void;
  sent: ClientMessage[];
}

function recordingTransport(): RecordingTransport {
  const sent: ClientMessage[] = [];
  return { send: (msg) => { sent.push(msg); }, sent };
}

interface HarnessOptions {
  model?: string;
  system?: string | undefined;
  systemRef?: { value: string | undefined };
  tools?: ToolDefinition[];
  toolsRef?: { value: ToolDefinition[] };
  provider?: 'anthropic' | 'openrouter' | 'openai';
  apiKey?: string;
  baseUrl?: string;
  toolExecutor?: (name: string, input: unknown, toolUseId: string) => Promise<{ content: string; is_error?: boolean }>;
}

function makeHarness(opts: HarnessOptions = {}) {
  const tx = recordingTransport();
  const handlers: ChatSessionHandlers = {
    onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn(),
  };
  const session = new ChatSession(
    tx as unknown as import('./transport-interface').SkaldTransport,
    () => opts.model ?? 'claude-sonnet-4-6',
    async () => opts.systemRef ? opts.systemRef.value : opts.system,
    () => ({ provider: opts.provider ?? 'anthropic', apiKey: opts.apiKey, baseUrl: opts.baseUrl }),
    () => opts.toolsRef ? opts.toolsRef.value : (opts.tools ?? []),
    opts.toolExecutor ?? (async () => ({ content: 'stub tool result' })),
    handlers,
  );
  return { tx, session, handlers };
}

function lastPayload(tx: RecordingTransport): ChatRequest {
  const last = tx.sent[tx.sent.length - 1];
  if (last.type !== 'chat') throw new Error(`last sent was not a chat: ${last.type}`);
  return last.payload;
}

function chatId(tx: RecordingTransport, ix = 0): string {
  const m = tx.sent[ix];
  if (m.type !== 'chat') throw new Error(`message ${ix} is not a chat`);
  return m.id;
}

function makeDoneMessage(id: string): ServerMessage {
  return { type: 'done', id, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } };
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
    const sysRef = { value: 'PROMPT_A' as string | undefined };
    const { tx, session } = makeHarness({ systemRef: sysRef });
    await session.sendUserText('first');
    session.handleServer(makeDoneMessage(chatId(tx)));
    sysRef.value = 'PROMPT_B';
    await session.sendUserText('second');
    expect(lastPayload(tx).system).toBe('PROMPT_B');
  });

  it('re-reads tool definitions on every turn (memory-tool gate applies immediately)', async () => {
    const toolsRef = { value: [{ name: 'read_note', input_schema: {} }] as ToolDefinition[] };
    const { tx, session } = makeHarness({ toolsRef });
    await session.sendUserText('turn 1');
    expect(lastPayload(tx).tools).toEqual([{ name: 'read_note', input_schema: {} }]);
    session.handleServer(makeDoneMessage(chatId(tx)));
    toolsRef.value = [{ name: 'read_note', input_schema: {} }, { name: 'remember_fact', input_schema: {} }];
    await session.sendUserText('turn 2');
    const turn2Tools = (lastPayload(tx).tools as ToolDefinition[]) ?? [];
    expect(turn2Tools.map((t) => t.name)).toEqual(['read_note', 'remember_fact']);
  });

  it('omits tools from payload entirely when toolDefinitionsProvider returns empty', async () => {
    const { tx, session } = makeHarness({ tools: [] });
    await session.sendUserText('hi');
    expect(lastPayload(tx).tools).toBeUndefined();
  });

  it('sets the wrapping provider + apiKey field for anthropic routes', async () => {
    const { tx, session } = makeHarness({ provider: 'anthropic', apiKey: 'sk-ant-xxx' });
    await session.sendUserText('hi');
    const msg = tx.sent[0];
    if (msg.type !== 'chat') throw new Error('expected chat');
    expect(msg.provider).toBe('anthropic');
    expect(msg.anthropic_api_key).toBe('sk-ant-xxx');
    expect(msg.openrouter_api_key).toBeUndefined();
  });

  it('sets the wrapping provider + apiKey field for openrouter routes', async () => {
    const { tx, session } = makeHarness({ provider: 'openrouter', apiKey: 'or-yyy' });
    await session.sendUserText('hi');
    const msg = tx.sent[0];
    if (msg.type !== 'chat') throw new Error('expected chat');
    expect(msg.provider).toBe('openrouter');
    expect(msg.openrouter_api_key).toBe('or-yyy');
    expect(msg.anthropic_api_key).toBeUndefined();
  });

  it('sets openai_api_key + openai_base_url for openai routes', async () => {
    const url = 'https://your-endpoint.example/v1';
    const { tx, session } = makeHarness({ provider: 'openai', apiKey: 'oai-zzz', baseUrl: url });
    await session.sendUserText('hi');
    const msg = tx.sent[0];
    if (msg.type !== 'chat') throw new Error('expected chat');
    expect(msg.provider).toBe('openai');
    expect(msg.openai_api_key).toBe('oai-zzz');
    expect(msg.openai_base_url).toBe(url);
    expect(msg.anthropic_api_key).toBeUndefined();
    expect(msg.openrouter_api_key).toBeUndefined();
  });

  it('sets openai_base_url even with no key (keyless endpoint)', async () => {
    const url = 'https://your-endpoint.example/v1';
    const { tx, session } = makeHarness({ provider: 'openai', apiKey: '', baseUrl: url });
    await session.sendUserText('hi');
    const msg = tx.sent[0];
    if (msg.type !== 'chat') throw new Error('expected chat');
    expect(msg.openai_api_key).toBeUndefined();
    expect(msg.openai_base_url).toBe(url);
  });

  it('passes a multi-modal content-block array through the payload unchanged', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserMessage([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
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
    session.handleServer(makeDoneMessage(chatId(tx)));
    session.reset();
    await session.sendUserText('fresh');
    expect(lastPayload(tx).messages).toEqual([{ role: 'user', content: 'fresh' }]);
  });

  it('zeroes totalUsage after reset', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserText('hi');
    session.handleServer(makeDoneMessage(chatId(tx)));
    expect(session.getTotalUsage().input_tokens).toBe(10);
    session.reset();
    expect(session.getTotalUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('mints a new conversationId on reset', async () => {
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
    session.handleServer({ type: 'error', id: chatId(tx), error: 'upstream broke' });
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
    if (cancelMsg.type === 'cancel') expect(cancelMsg.id).toBe(turnId);
  });

  it('is a no-op when no turn is in-flight', () => {
    const { tx, session } = makeHarness();
    session.cancel();
    expect(tx.sent).toHaveLength(0);
  });
});

describe('ChatSession.hydrate', () => {
  it('seeds messages and conversationId from prior conversation', () => {
    const { session } = makeHarness();
    const prior = [
      { role: 'user' as const, content: 'hello from the past' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    session.hydrate({ conversationId: 'conv-123', messages: prior });
    expect(session.conversationId).toBe('conv-123');
    expect(session.getMessages()).toEqual(prior);
  });

  it('restores cumulative usage so the cost footer continues', () => {
    const { session } = makeHarness();
    session.hydrate({
      conversationId: 'conv-abc',
      messages: [{ role: 'user', content: 'x' }],
      usage: { input_tokens: 500, output_tokens: 1500, cache_read_input_tokens: 100 },
    });
    const u = session.getTotalUsage();
    expect(u.input_tokens).toBe(500);
    expect(u.output_tokens).toBe(1500);
    expect(u.cache_read_input_tokens).toBe(100);
  });

  it('zeroes usage when none is provided', () => {
    const { session } = makeHarness();
    session.hydrate({ conversationId: 'x', messages: [{ role: 'user', content: 'y' }] });
    expect(session.getTotalUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('is ignored when a turn is in flight', async () => {
    const { session } = makeHarness();
    await session.sendUserText('in-flight message');
    expect(session.isInFlight()).toBe(true);
    const idBefore = session.conversationId;
    session.hydrate({ conversationId: 'should-not-apply', messages: [] });
    expect(session.conversationId).toBe(idBefore);
  });

  it('seeded messages appear in the next dispatch payload', async () => {
    const { tx, session } = makeHarness();
    session.hydrate({
      conversationId: 'conv-xyz',
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
      ],
    });
    await session.sendUserText('new question');
    const msgs = lastPayload(tx).messages;
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'new question' });
    expect(msgs.some((m) => m.content === 'old question')).toBe(true);
  });
});

// ── parallel tool execution ────────────────────────────────────────────────

/** Simulate a complete tool_use assistant turn + server done(tool_use).
 * Must be awaited after sendUserText so dispatch() has had a chance to
 * run its async systemProvider await and call transport.send. */
async function injectToolTurn(
  session: ChatSession,
  tx: RecordingTransport,
  tools: { id: string; name: string }[],
): Promise<void> {
  // Flush the microtask queue so dispatch()'s async systemProvider
  // completes and transport.send is called before we read chatId.
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

/** Find tool_result blocks in the session's message history. */
function getToolResults(session: ChatSession): Record<string, unknown>[] {
  for (const m of session.getMessages()) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      const bs = m.content as Record<string, unknown>[];
      if (bs.some((b) => b.type === 'tool_result')) return bs;
    }
  }
  return [];
}

/** Wait until the recording transport has at least `count` messages.
 * After injectToolTurn fires the tool_use done event, executeToolsAndContinue
 * runs async (fire-and-forget from handleServer). This drains the microtask
 * queue until the second dispatch (turn 2) has been sent. */
async function waitForDispatches(tx: RecordingTransport, count: number): Promise<void> {
  // Each Promise.resolve() flush processes one level of microtasks.
  // Two levels: (1) finalize resolves, (2) executeToolsAndContinue resolves.
  for (let i = 0; i < 10 && tx.sent.length < count; i++) {
    await Promise.resolve();
  }
}

describe('ChatSession.executeToolsAndContinue: parallel reads', () => {
  it('all read tool_uses produce a tool_result', async () => {
    const called: string[] = [];
    const { tx, session } = makeHarness({
      toolExecutor: async (_n, _i, id) => { called.push(id); return { content: 'ok' }; },
    });
    void session.sendUserText('q');
    await injectToolTurn(session, tx, [{ id: 'r1', name: 'read_note' }, { id: 'r2', name: 'list_notes' }]);
    await waitForDispatches(tx, 2); // wait for turn-2 dispatch after tool execution
    const res = getToolResults(session);
    expect(res.map((b) => b.tool_use_id)).toContain('r1');
    expect(res.map((b) => b.tool_use_id)).toContain('r2');
    expect(called).toContain('r1');
    expect(called).toContain('r2');
  });

  it('a thrown read yields error tool_result, not a missing block', async () => {
    const { tx, session } = makeHarness({
      toolExecutor: async (_n, _i, id) => {
        if (id === 'bad') throw new Error('vault error');
        return { content: 'ok' };
      },
    });
    void session.sendUserText('q');
    await injectToolTurn(session, tx, [{ id: 'bad', name: 'read_note' }, { id: 'good', name: 'list_notes' }]);
    await waitForDispatches(tx, 2);
    const res = getToolResults(session);
    expect(res).toHaveLength(2);
    const errBlock = res.find((b) => b.tool_use_id === 'bad')!;
    expect(errBlock.is_error).toBe(true);
    expect(typeof errBlock.content).toBe('string');
  });

  it('results preserve original tool_use order', async () => {
    const { tx, session } = makeHarness({
      toolExecutor: async (_n, _i, id) => ({ content: id }),
    });
    void session.sendUserText('q');
    await injectToolTurn(session, tx, [
      { id: 'first', name: 'read_note' }, { id: 'second', name: 'current_note' },
    ]);
    await waitForDispatches(tx, 2);
    expect(getToolResults(session).map((b) => b.tool_use_id)).toEqual(['first', 'second']);
  });

  it('write runs after reads in a mixed turn', async () => {
    const callOrder: string[] = [];
    const { tx, session } = makeHarness({
      toolExecutor: async (_n, _i, id) => { callOrder.push(id); return { content: 'ok' }; },
    });
    void session.sendUserText('q');
    await injectToolTurn(session, tx, [
      { id: 'read1', name: 'read_note' }, { id: 'write1', name: 'write_note' },
    ]);
    await waitForDispatches(tx, 2);
    expect(callOrder).toContain('read1');
    expect(callOrder).toContain('write1');
    expect(callOrder.indexOf('write1')).toBeGreaterThan(callOrder.indexOf('read1'));
  });
});
