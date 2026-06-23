/**
 * Multi-frame streaming delta reassembly tests for ChatSession.
 *
 * These tests feed 2-3 consecutive delta chunks for each accumulator
 * (text_delta, input_json_delta, thinking_delta) and assert that the
 * finalized block reflects CONCATENATED content — not just the last
 * fragment or the first fragment.
 *
 * Non-vacuity proof: each accumulator was temporarily changed from
 *   `(x ?? '') + delta.y`  →  `delta.y`   (overwrite instead of append)
 * and the corresponding test was confirmed to FAIL before restoring.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@skald/protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';

// ── minimal harness ────────────────────────────────────────────────────────

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

function makeHandlers(): ChatSessionHandlers {
  return { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() };
}

function makeSession(tx: RecordingTransport, handlers: ChatSessionHandlers): ChatSession {
  return new ChatSession(
    tx as unknown as import('./transport-interface').SkaldTransport,
    () => 'claude-sonnet-4-6',
    async () => undefined,
    () => ({ provider: 'anthropic' as const }),
    () => [],
    async () => ({ content: 'stub' }),
    handlers,
  );
}

// ── helpers to inject SSE events ──────────────────────────────────────────

function blockStart(session: ChatSession, mid: string, index: number, contentBlock: Record<string, unknown>): void {
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_start',
    data: { index, content_block: contentBlock },
  });
}

function textDelta(session: ChatSession, mid: string, index: number, text: string): void {
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_delta',
    data: { index, delta: { type: 'text_delta', text } },
  });
}

function inputJsonDelta(session: ChatSession, mid: string, index: number, partial_json: string): void {
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_delta',
    data: { index, delta: { type: 'input_json_delta', partial_json } },
  });
}

function thinkingDelta(session: ChatSession, mid: string, index: number, thinking: string): void {
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_delta',
    data: { index, delta: { type: 'thinking_delta', thinking } },
  });
}

function blockStop(session: ChatSession, mid: string, index: number): void {
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_stop',
    data: { index },
  });
}

function done(session: ChatSession, mid: string): void {
  session.handleServer({
    type: 'done', id: mid, stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  });
}

// Extract the first assistant message's blocks after finalize.
function getAssistantBlocks(session: ChatSession): Record<string, unknown>[] {
  const msgs = session.getMessages();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return m.content as Record<string, unknown>[];
    }
  }
  return [];
}

// ── text_delta concatenation ──────────────────────────────────────────────

describe('streaming delta reassembly: text_delta', () => {
  it('concatenates three consecutive text_delta frames into a single block.text', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('hello');
    await Promise.resolve(); // let dispatch() run and call transport.send

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'text', text: '' });
    textDelta(session, mid, 0, 'Hello');
    textDelta(session, mid, 0, ', ');
    textDelta(session, mid, 0, 'world!');
    blockStop(session, mid, 0);
    done(session, mid);

    await Promise.resolve(); // let finalize() run

    const blocks = getAssistantBlocks(session);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    // All three fragments must appear in the final text — overwrite would
    // leave only 'world!' or only 'Hello'.
    expect(blocks[0].text).toBe('Hello, world!');
  });

  it('accumulates text across two delta frames (catches overwrite-first regression)', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('ping');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'text', text: '' });
    textDelta(session, mid, 0, 'First');
    textDelta(session, mid, 0, 'Second');
    blockStop(session, mid, 0);
    done(session, mid);

    await Promise.resolve();

    const blocks = getAssistantBlocks(session);
    // Overwrite-first (delta.text without accumulation) would give 'Second' only.
    expect(blocks[0].text).toBe('FirstSecond');
  });

  it('reads correct concatenated text from getInFlight during streaming', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('stream check');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'text', text: '' });
    textDelta(session, mid, 0, 'Part A');
    textDelta(session, mid, 0, ' Part B');

    // Inspect the live in-flight buffer (not yet finalized).
    const inFlight = session.getInFlight();
    expect(inFlight).not.toBeNull();
    const liveBlock = (inFlight!.blocks as Record<string, unknown>[])[0];
    // Overwrite would yield ' Part B'; concatenation yields 'Part A Part B'.
    expect(liveBlock.text).toBe('Part A Part B');
  });
});

// ── input_json_delta concatenation ────────────────────────────────────────

describe('streaming delta reassembly: input_json_delta', () => {
  it('reassembles JSON split across three frames into parseable tool input', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('use a tool');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'tool_use', id: 'tu-1', name: 'read_note', input: {} });
    // JSON split across three frames: {"path": "my-note.md"}
    inputJsonDelta(session, mid, 0, '{"path"');
    inputJsonDelta(session, mid, 0, ': "my-no');
    inputJsonDelta(session, mid, 0, 'te.md"}');
    blockStop(session, mid, 0); // triggers JSON.parse of partial_json → input
    done(session, mid);

    await Promise.resolve();

    const blocks = getAssistantBlocks(session);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_use');
    // After content_block_stop, partial_json is deleted and input is set.
    // Overwrite-last would give JSON.parse('te.md"}') which throws → input = {}.
    // Correct concatenation gives {"path": "my-note.md"}.
    expect(blocks[0].input).toEqual({ path: 'my-note.md' });
  });

  it('reassembles two-frame JSON and does not fall back to {} fallback', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('two-frame tool');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'tool_use', id: 'tu-2', name: 'write_note', input: {} });
    inputJsonDelta(session, mid, 0, '{"title":"My Note","body":');
    inputJsonDelta(session, mid, 0, '"Hello world"}');
    blockStop(session, mid, 0);
    done(session, mid);

    await Promise.resolve();

    const blocks = getAssistantBlocks(session);
    // Overwrite-first would parse '{"title":"My Note","body":' → throws → {}
    // Overwrite-last would parse '"Hello world"}' → throws → {}
    // Correct: concatenated full JSON parses correctly.
    expect(blocks[0].input).toEqual({ title: 'My Note', body: 'Hello world' });
    // partial_json must be deleted after block_stop
    expect(blocks[0].partial_json).toBeUndefined();
  });

  it('accumulates partial_json in-flight across two frames before block_stop', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('check in-flight json');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'tool_use', id: 'tu-3', name: 'read_note', input: {} });
    inputJsonDelta(session, mid, 0, '{"a":');
    inputJsonDelta(session, mid, 0, '"b"}');

    // Inspect live partial_json before block_stop.
    const inFlight = session.getInFlight();
    expect(inFlight).not.toBeNull();
    const liveBlock = (inFlight!.blocks as Record<string, unknown>[])[0];
    // Overwrite-last would give '"b"}'; concatenation gives '{"a":"b"}'.
    expect(liveBlock.partial_json).toBe('{"a":"b"}');
  });
});

// ── thinking_delta concatenation ──────────────────────────────────────────

describe('streaming delta reassembly: thinking_delta', () => {
  it('concatenates three thinking_delta frames into a single thinking string', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('think about it');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'thinking', thinking: '', signature: '' });
    thinkingDelta(session, mid, 0, 'First thought. ');
    thinkingDelta(session, mid, 0, 'Second thought. ');
    thinkingDelta(session, mid, 0, 'Third thought.');
    blockStop(session, mid, 0);
    done(session, mid);

    await Promise.resolve();

    const blocks = getAssistantBlocks(session);
    expect(blocks).toHaveLength(1);
    // Overwrite-last would give 'Third thought.' only.
    expect(blocks[0].thinking).toBe('First thought. Second thought. Third thought.');
  });

  it('accumulates two thinking_delta frames (catches overwrite-first regression)', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('two think frames');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'thinking', thinking: '', signature: '' });
    thinkingDelta(session, mid, 0, 'Alpha');
    thinkingDelta(session, mid, 0, 'Beta');
    blockStop(session, mid, 0);
    done(session, mid);

    await Promise.resolve();

    const blocks = getAssistantBlocks(session);
    // Overwrite-first (delta.thinking without accumulation) would give 'Beta'.
    // Overwrite-last would give 'Beta' too. Only concatenation gives 'AlphaBeta'.
    expect(blocks[0].thinking).toBe('AlphaBeta');
  });

  it('reads concatenated thinking from getInFlight before finalize', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('live think check');
    await Promise.resolve();

    const mid = chatId(tx);
    blockStart(session, mid, 0, { type: 'thinking', thinking: '', signature: '' });
    thinkingDelta(session, mid, 0, 'Premise: ');
    thinkingDelta(session, mid, 0, 'the sky is blue.');

    const inFlight = session.getInFlight();
    expect(inFlight).not.toBeNull();
    const liveBlock = (inFlight!.blocks as Record<string, unknown>[])[0];
    // Overwrite would yield 'the sky is blue.' without the prefix.
    expect(liveBlock.thinking).toBe('Premise: the sky is blue.');
  });
});

// ── mixed: thinking block + text block in the same turn ───────────────────

describe('streaming delta reassembly: mixed thinking + text in one turn', () => {
  it('correctly reassembles both blocks when thinking precedes text in the same response', async () => {
    const tx = recordingTransport();
    const handlers = makeHandlers();
    const session = makeSession(tx, handlers);

    void session.sendUserText('mixed turn');
    await Promise.resolve();

    const mid = chatId(tx);
    // Block 0: thinking
    blockStart(session, mid, 0, { type: 'thinking', thinking: '', signature: '' });
    thinkingDelta(session, mid, 0, 'I should ');
    thinkingDelta(session, mid, 0, 'say hello.');
    blockStop(session, mid, 0);
    // Block 1: text
    blockStart(session, mid, 1, { type: 'text', text: '' });
    textDelta(session, mid, 1, 'Hello ');
    textDelta(session, mid, 1, 'there!');
    blockStop(session, mid, 1);
    done(session, mid);

    await Promise.resolve();

    const blocks = getAssistantBlocks(session);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].thinking).toBe('I should say hello.');
    expect(blocks[1].text).toBe('Hello there!');
  });
});
