/**
 * End-to-end write-approval integration for ChatSession.
 *
 * The unit suites mock the tool executor wholesale; this test drives a
 * `write_note` tool_use through the REAL executeTool → runWriteNote →
 * approve path, so it exercises the wiring those mocks skip: the approval
 * decision actually gates the vault write, and the tool_result that flows
 * back into the next request reflects the outcome.
 *
 * Only the leaf dependencies are mocked — the vault (an in-memory App stub)
 * and the model stream (a recording transport with hand-injected SSE-shaped
 * events). The executor, approval flow, and result-block assembly are all
 * the production code.
 *
 *   - rejected → tool_result is_error with rejection copy AND vault.create
 *     is never called (no write).
 *   - approved → vault.create is called AND the tool_result reports success.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { ClientMessage, Message } from '@skald/protocol';
import { ChatSession, type ChatSessionHandlers } from './chat-session';
import { executeTool } from './tools';
import type { ApproveFn } from './tools/context';

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

/** In-memory vault. write_note on a missing path → vault.create. */
function makeApp() {
  const create = vi.fn(async () => {});
  const modify = vi.fn(async () => {});
  const app = {
    vault: {
      // The note doesn't exist yet → create path (no instanceof TFile match).
      getAbstractFileByPath: () => null,
      read: async () => '',
      create,
      modify,
      createFolder: async () => {},
      getAbstractFileByPath_create: create,
    },
  } as unknown as App;
  return { app, create, modify };
}

/** Inject a single write_note tool_use assistant turn + done(tool_use). */
async function injectWriteToolTurn(
  session: ChatSession,
  tx: RecordingTransport,
): Promise<void> {
  await Promise.resolve();
  const mid = chatId(tx);
  session.handleServer({
    type: 'chunk', id: mid, event: 'content_block_start',
    data: {
      index: 0,
      content_block: {
        type: 'tool_use', id: 'w1', name: 'write_note',
        input: { path: 'Daily/today.md', content: 'hello world' },
      },
    },
  });
  session.handleServer({ type: 'chunk', id: mid, event: 'content_block_stop', data: { index: 0 } });
  session.handleServer({
    type: 'done', id: mid, stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 5 },
  });
}

function buildSession(approve: ApproveFn, app: App, tx: RecordingTransport) {
  const handlers: ChatSessionHandlers = {
    onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn(),
  };
  return new ChatSession(
    tx as unknown as import('./transport-interface').SkaldTransport,
    () => 'claude-sonnet-4-6',
    async () => undefined,
    () => ({ provider: 'anthropic' }),
    () => [],
    // Real executor — routes write_note through runWriteNote → approve.
    (name, input, id) => executeTool(name, input, id, { app, approve }),
    handlers,
  );
}

/** Pull the tool_result block for w1 out of the continuation user turn. */
function toolResultFor(messages: Message[], id: string): any {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const block = m.content.find(
      (b: any) => b.type === 'tool_result' && b.tool_use_id === id,
    );
    if (block) return block;
  }
  return undefined;
}

describe('ChatSession write approval (real executeTool path)', () => {
  it('rejected approval → error tool_result and NO vault write', async () => {
    const { app, create, modify } = makeApp();
    const approve = vi.fn(async () => false) as ApproveFn;
    const tx = recordingTransport();
    const session = buildSession(approve, app, tx);

    void session.sendUserText('write a note');
    await injectWriteToolTurn(session, tx);
    // Let the executor + continuation dispatch settle.
    for (let i = 0; i < 10 && tx.sent.length < 2; i++) await Promise.resolve();

    expect(approve).toHaveBeenCalledOnce();
    // The decision actually gated the write — vault untouched.
    expect(create).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();

    const result = toolResultFor(session.getMessages(), 'w1');
    expect(result).toBeDefined();
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/rejected/i);
  });

  it('approved approval → vault write happens and tool_result reports success', async () => {
    const { app, create } = makeApp();
    const approve = vi.fn(async () => true) as ApproveFn;
    const tx = recordingTransport();
    const session = buildSession(approve, app, tx);

    void session.sendUserText('write a note');
    await injectWriteToolTurn(session, tx);
    for (let i = 0; i < 10 && tx.sent.length < 2; i++) await Promise.resolve();

    expect(approve).toHaveBeenCalledOnce();
    // The write actually committed to the vault.
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith('Daily/today.md', 'hello world');

    const result = toolResultFor(session.getMessages(), 'w1');
    expect(result).toBeDefined();
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Daily/today.md');
  });
});
