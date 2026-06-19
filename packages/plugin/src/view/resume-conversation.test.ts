/**
 * resumeConversation orchestrator tests. The flow itself owns no parsing
 * or rendering logic — it wires read → parse → hydrate → repaint, with a
 * read-only fallback when the file isn't a parseable skald conversation.
 * These tests pin that wiring: hydrate runs with the parsed payload on the
 * happy path, and on a parse miss the fallback opens the note instead.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Message, Usage } from '@skald/protocol';
import type { TFile } from 'obsidian';
import { resumeConversation, type ResumeContext } from './resume-conversation';
import { ChatSession } from '../chat-session';
import * as store from '../conversation-store';

const noticeSpy = vi.fn();
vi.mock('obsidian', async () => {
  const actual = await vi.importActual<typeof import('obsidian')>('obsidian');
  return { ...actual, Notice: class { constructor(m: string) { noticeSpy(m); } } };
});

vi.mock('../conversation-store', () => ({
  parseConversationMarkdown: vi.fn(),
}));

const parseMock = vi.mocked(store.parseConversationMarkdown);

function fakeFile(path = 'Chats/2026-06-14-hi-abc123.md'): TFile {
  return { path } as TFile;
}

/** A minimal session double with the surface resumeConversation touches. */
function fakeSession() {
  return {
    hydrate: vi.fn(),
    getMessages: vi.fn((): Message[] => [{ role: 'user', content: 'hi' }]),
    getTotalUsage: vi.fn(() => ({ input_tokens: 0, output_tokens: 0 })),
  };
}

function makeCtx(opts: {
  content: string;
  session?: ReturnType<typeof fakeSession>;
}): ResumeContext & { session: ReturnType<typeof fakeSession> } {
  const session = opts.session ?? fakeSession();
  const openLinkText = vi.fn();
  return {
    app: {
      vault: { read: vi.fn(async () => opts.content) },
      workspace: { openLinkText },
    } as unknown as ResumeContext['app'],
    session,
    connect: vi.fn(),
    messageList: {
      tearDown: vi.fn(),
      flushRender: vi.fn(async () => {}),
    } as unknown as ResumeContext['messageList'],
    dropSessionState: vi.fn(),
    getModelValue: () => 'claude-sonnet-4-6',
    getTransport: () => ({ close: vi.fn() }),
    setTransport: vi.fn(),
    setSession: vi.fn(),
    usageFooterEl: { style: {}, setText: vi.fn() } as unknown as HTMLDivElement,
    onPreClear: vi.fn(),
  } as unknown as ResumeContext & { session: ReturnType<typeof fakeSession> };
}

beforeEach(() => {
  parseMock.mockReset();
  noticeSpy.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('resumeConversation: happy path', () => {
  it('hydrates the session with parsed messages + id and repaints the list', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    parseMock.mockReturnValue({
      meta: { id: 'conv-1', model: 'claude-haiku-4-5' },
      messages,
    });

    const ctx = makeCtx({ content: 'irrelevant — parse is mocked' });
    await resumeConversation(fakeFile(), ctx);

    expect(ctx.session.hydrate).toHaveBeenCalledOnce();
    expect(ctx.session.hydrate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', messages }),
    );
    // The repaint flush is invoked with the session's current messages.
    expect(ctx.messageList.flushRender).toHaveBeenCalledOnce();
  });
});

describe('resumeConversation: usage continuity', () => {
  it('threads saved usage into the session accumulator (cost footer not zeroed)', async () => {
    const savedUsage: Usage = {
      input_tokens: 120_000,
      output_tokens: 40_000,
      cache_read_input_tokens: 9000,
    };
    const messages: Message[] = [{ role: 'user', content: 'hello again' }];
    parseMock.mockReturnValue({
      meta: { id: 'conv-cost', model: 'claude-sonnet-4-6', usage: savedUsage },
      messages,
    });

    // A REAL ChatSession so hydrate's usage-restore is exercised end-to-end,
    // not a vi.fn() that would swallow the threading. resumeConversation reads
    // ctx.session AFTER connect(); we pre-seed both slots with the same real
    // session so the hydrate target is the one we inspect.
    const real = new ChatSession(
      { send: vi.fn() } as unknown as import('../transport').Transport,
      () => 'claude-sonnet-4-6',
      async () => undefined,
      () => ({ provider: 'anthropic' }),
      () => [],
      async () => ({ content: 'ok' }),
      { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() },
    );
    // Before resume, the accumulator is zero.
    expect(real.getTotalUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });

    const ctx = makeCtx({ content: 'irrelevant — parse is mocked' });
    (ctx as unknown as { session: ChatSession }).session = real;
    await resumeConversation(fakeFile(), ctx);

    // Saved usage now lives on the session — the footer can show real spend.
    // FAILS under mutation "drop `usage` from the hydrate call in
    // resume-conversation.ts" — the accumulator would stay zeroed.
    expect(real.getTotalUsage()).toEqual(savedUsage);
  });
});

describe('resumeConversation: parse failure', () => {
  it('opens the note for reading and does NOT hydrate when parse returns null', async () => {
    parseMock.mockReturnValue(null);

    const ctx = makeCtx({ content: 'not a skald conversation' });
    const file = fakeFile('Chats/random.md');
    await resumeConversation(file, ctx);

    expect(ctx.session.hydrate).not.toHaveBeenCalled();
    expect(ctx.app.workspace.openLinkText).toHaveBeenCalledWith(
      file.path,
      '',
      false,
    );
    // The fallback surfaces a Notice to the user.
    expect(noticeSpy).toHaveBeenCalled();
  });
});
