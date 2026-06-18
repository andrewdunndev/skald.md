/**
 * Chat-session integration tests for the Citations API path.
 * Pure citations.ts helpers are tested in citations.test.ts.
 *
 * Covers:
 *   1. citations_delta streaming accumulation on text blocks
 *   2. Malformed citations_delta does not corrupt the block
 *   3. Document blocks injected alongside tool_result when enabled
 *   4. Document blocks NOT injected when citations=false (OpenRouter)
 *   5. Error tool results do not get document blocks
 *   6. documentRegistry populated for renderer lookup
 *   7. Normal (non-citation) text turns unaffected
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ServerMessage,
  ToolDefinition,
} from '@scribian/protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';

// ── helpers ───────────────────────────────────────────────────────────────────

interface RecordingTransport {
  send: (msg: ClientMessage) => void;
  sent: ClientMessage[];
}

function recordingTransport(): RecordingTransport {
  const sent: ClientMessage[] = [];
  return { send: (msg) => { sent.push(msg); }, sent };
}

function makeHarness(opts: {
  tools?: ToolDefinition[];
  toolExecutor?: (name: string, input: unknown, id: string) => Promise<{ content: string; is_error?: boolean }>;
  citationsEnabled?: boolean;
} = {}) {
  const tx = recordingTransport();
  const handlers: ChatSessionHandlers = {
    onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn(),
  };
  const session = new ChatSession(
    tx as unknown as import('./transport').Transport,
    () => 'claude-sonnet-4-6',
    async () => undefined,
    () => ({ provider: 'anthropic', apiKey: 'test' }),
    () => opts.tools ?? [],
    opts.toolExecutor ?? (async () => ({ content: 'stub' })),
    handlers,
    () => opts.citationsEnabled ?? false,
  );
  return { tx, session, handlers };
}

function chatId(tx: RecordingTransport, ix = 0): string {
  const m = tx.sent[ix];
  if (m.type !== 'chat') throw new Error(`message ${ix} is not a chat`);
  return m.id;
}

function makeDone(id: string): ServerMessage {
  return { type: 'done', id, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } };
}

function chunk(mid: string, event: string, data: unknown): ServerMessage {
  return { type: 'chunk', id: mid, event, data } as ServerMessage;
}

// ── citations_delta streaming ─────────────────────────────────────────────────

describe('citations_delta accumulates onto text block', () => {
  it('appends citation to the block when citations_delta arrives', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserText('hello');
    const mid = chatId(tx);

    session.handleServer(chunk(mid, 'content_block_start',
      { index: 0, content_block: { type: 'text', text: '' } }));
    session.handleServer(chunk(mid, 'content_block_delta',
      { index: 0, delta: { type: 'text_delta', text: 'The grass is green.' } }));
    session.handleServer(chunk(mid, 'content_block_delta', {
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'char_location',
          cited_text: 'The grass is green.',
          document_index: 0,
          document_title: 'notes/test.md',
          start_char_index: 0,
          end_char_index: 19,
        },
      },
    }));
    session.handleServer(chunk(mid, 'content_block_stop', { index: 0 }));
    session.handleServer(makeDone(mid));

    const msgs = session.getMessages();
    const blocks = msgs[msgs.length - 1].content as Record<string, unknown>[];
    const textBlock = blocks[0];
    expect(textBlock.text).toBe('The grass is green.');
    expect(Array.isArray(textBlock.citations)).toBe(true);
    const citations = textBlock.citations as Record<string, unknown>[];
    expect(citations).toHaveLength(1);
    expect(citations[0].type).toBe('char_location');
    expect(citations[0].document_index).toBe(0);
  });

  it('malformed citations_delta (bad type) does not corrupt the block', async () => {
    const { tx, session } = makeHarness();
    await session.sendUserText('hello');
    const mid = chatId(tx);

    session.handleServer(chunk(mid, 'content_block_start',
      { index: 0, content_block: { type: 'text', text: '' } }));
    session.handleServer(chunk(mid, 'content_block_delta',
      { index: 0, delta: { type: 'text_delta', text: 'Hello.' } }));
    session.handleServer(chunk(mid, 'content_block_delta', {
      index: 0,
      delta: { type: 'citations_delta', citation: { type: 'unknown', foo: 'bar' } },
    }));
    session.handleServer(chunk(mid, 'content_block_stop', { index: 0 }));
    session.handleServer(makeDone(mid));

    const blocks = session.getMessages()[session.getMessages().length - 1]
      .content as Record<string, unknown>[];
    expect(blocks[0].text).toBe('Hello.');
    const cits = blocks[0].citations as unknown[] | undefined;
    expect(!cits || cits.length === 0).toBe(true);
  });
});

// ── document block injection ──────────────────────────────────────────────────

const readNoteTool: ToolDefinition = {
  name: 'read_note',
  description: 'Read a note',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

async function driveToolTurn(
  session: ReturnType<typeof makeHarness>['session'],
  tx: RecordingTransport,
  toolId: string,
  path: string,
): Promise<void> {
  const mid = chatId(tx, 0);
  session.handleServer(chunk(mid, 'content_block_start',
    { index: 0, content_block: { type: 'tool_use', id: toolId, name: 'read_note', input: {} } }));
  session.handleServer(chunk(mid, 'content_block_delta',
    { index: 0, delta: { type: 'input_json_delta', partial_json: `{"path":"${path}"}` } }));
  session.handleServer(chunk(mid, 'content_block_stop', { index: 0 }));
  await session.handleServer({
    type: 'done', id: mid, stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 5 },
  } as ServerMessage);
  await new Promise((r) => setTimeout(r, 10));
}

describe('document blocks injected on citations=true path', () => {
  it('injects document block alongside tool_result for read_note', async () => {
    const toolExecutor = vi.fn().mockResolvedValue({ content: 'The grass is green.' });
    const { tx, session } = makeHarness({
      tools: [readNoteTool], toolExecutor, citationsEnabled: true,
    });

    await session.sendUserText('What is in my note?');
    await driveToolTurn(session, tx, 'tu-1', 'notes/foo.md');

    const payload = (tx.sent[1] as Extract<ClientMessage, { type: 'chat' }>).payload;
    const content = payload.messages[payload.messages.length - 1]
      .content as Record<string, unknown>[];

    const toolResult = content.find((b) => b.type === 'tool_result');
    const docBlock = content.find((b) => b.type === 'document');
    expect(toolResult).toBeDefined();
    expect(docBlock).toBeDefined();
    expect(docBlock?.title).toBe('notes/foo.md');
    expect((docBlock?.citations as Record<string, unknown>)?.enabled).toBe(true);
    expect((docBlock?.source as Record<string, unknown>)?.data).toBe('The grass is green.');
  });

  it('does NOT inject document blocks when citationsEnabled=false (OpenRouter)', async () => {
    const toolExecutor = vi.fn().mockResolvedValue({ content: 'body' });
    const { tx, session } = makeHarness({
      tools: [readNoteTool], toolExecutor, citationsEnabled: false,
    });

    await session.sendUserText('hi');
    await driveToolTurn(session, tx, 'tu-2', 'a.md');

    const payload = (tx.sent[1] as Extract<ClientMessage, { type: 'chat' }>).payload;
    const content = payload.messages[payload.messages.length - 1]
      .content as Record<string, unknown>[];
    expect(content.find((b) => b.type === 'document')).toBeUndefined();
  });

  it('skips document injection for error tool results', async () => {
    const toolExecutor = vi.fn().mockResolvedValue({ content: 'Note not found', is_error: true });
    const { tx, session } = makeHarness({
      tools: [readNoteTool], toolExecutor, citationsEnabled: true,
    });

    await session.sendUserText('hi');
    await driveToolTurn(session, tx, 'tu-3', 'missing.md');

    const payload = (tx.sent[1] as Extract<ClientMessage, { type: 'chat' }>).payload;
    const content = payload.messages[payload.messages.length - 1]
      .content as Record<string, unknown>[];
    expect(content.find((b) => b.type === 'document')).toBeUndefined();
  });

  it('documentRegistry is populated for renderer lookup', async () => {
    const toolExecutor = vi.fn().mockResolvedValue({ content: 'body text' });
    const { tx, session } = makeHarness({
      tools: [readNoteTool], toolExecutor, citationsEnabled: true,
    });

    await session.sendUserText('hi');
    await driveToolTurn(session, tx, 'tu-4', 'notes/doc.md');

    expect(session.documentRegistry.get(0)).toBe('notes/doc.md');
  });
});

// ── non-citation turns unaffected ─────────────────────────────────────────────

describe('non-citation text blocks are unaffected', () => {
  it('a normal text turn has no citations field', async () => {
    const { tx, session, handlers } = makeHarness();
    await session.sendUserText('hello');
    const mid = chatId(tx);

    session.handleServer(chunk(mid, 'content_block_start',
      { index: 0, content_block: { type: 'text', text: '' } }));
    session.handleServer(chunk(mid, 'content_block_delta',
      { index: 0, delta: { type: 'text_delta', text: 'Plain answer.' } }));
    session.handleServer(chunk(mid, 'content_block_stop', { index: 0 }));
    session.handleServer(makeDone(mid));

    const msgs = session.getMessages();
    const blocks = msgs[msgs.length - 1].content as Record<string, unknown>[];
    expect(blocks[0].text).toBe('Plain answer.');
    expect(blocks[0].citations).toBeUndefined();
    expect(handlers.onDone).toHaveBeenCalledOnce();
  });
});
