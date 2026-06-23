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

/**
 * Models the view's mutable session slot. resumeConversation reads it via
 * the getSession getter; connect() swaps it. Holding the slot in a closure
 * (rather than a fixed property) is what lets a test mimic the real view,
 * where connect() reassigns this.session to a fresh instance.
 */
type FakeSession = ReturnType<typeof fakeSession>;

/**
 * Models the view's mutable session slot. resumeConversation reads it via
 * the getSession getter; connect() swaps it. Holding the slot in a closure
 * (rather than a fixed property) is what lets a test mimic the real view,
 * where connect() reassigns this.session to a fresh instance — the heart of
 * the detached-session bug this suite guards.
 */
function makeCtx(opts: {
  content: string;
  session?: FakeSession | null;
  /** Called inside connect(); return value becomes the new live session. */
  onConnect?: () => FakeSession;
}): ResumeContext & { liveSession: () => unknown } {
  const initial: FakeSession | null =
    opts.session === undefined ? fakeSession() : opts.session;
  let session: FakeSession | null = initial;
  const openLinkText = vi.fn();
  return {
    app: {
      vault: { read: vi.fn(async () => opts.content) },
      workspace: { openLinkText },
    } as unknown as ResumeContext['app'],
    getSession: () => session as unknown as ChatSession | null,
    // In the real view, connect() ALWAYS installs a session. setSession(null)
    // ran just before, so the default here restores the original (the simple
    // no-swap case); onConnect lets a test install a distinct fresh session to
    // exercise the post-connect read.
    connect: vi.fn(() => {
      session = opts.onConnect ? opts.onConnect() : initial;
    }),
    messageList: {
      tearDown: vi.fn(),
      flushRender: vi.fn(async () => {}),
    } as unknown as ResumeContext['messageList'],
    dropSessionState: vi.fn(),
    getModelValue: () => 'claude-sonnet-4-6',
    getTransport: () => ({ close: vi.fn() }),
    setTransport: vi.fn(),
    setSession: vi.fn(() => { session = null; }),
    usageFooterEl: { style: {}, setText: vi.fn() } as unknown as HTMLDivElement,
    onPreClear: vi.fn(),
    liveSession: () => session,
  } as unknown as ResumeContext & { liveSession: () => unknown };
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

    const live = ctx.liveSession() as FakeSession;
    expect(live.hydrate).toHaveBeenCalledOnce();
    expect(live.hydrate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', messages }),
    );
    // The repaint flush is invoked with the session's current messages.
    expect(ctx.messageList.flushRender).toHaveBeenCalledOnce();
  });
});

describe('resumeConversation: detached-session regression', () => {
  it('hydrates the POST-connect live session, not the pre-connect original', async () => {
    // The real view does this: setSession(null) drops the current session,
    // then connect() installs a brand-new one on the view. resumeConversation
    // must hydrate that NEW session — the reference send() will dispatch
    // through — not the original it was handed before connect ran.
    const messages: Message[] = [
      { role: 'user', content: 'resumed question' },
      { role: 'assistant', content: 'resumed answer' },
    ];
    parseMock.mockReturnValue({
      meta: { id: 'conv-resumed', model: 'claude-sonnet-4-6' },
      messages,
    });

    const original = fakeSession(); // the detached one — must stay untouched
    const fresh = fakeSession(); // what connect() installs
    const ctx = makeCtx({
      content: 'irrelevant — parse is mocked',
      session: original,
      onConnect: () => fresh,
    });

    await resumeConversation(fakeFile(), ctx);

    // The live session after resume is the fresh, connected one...
    expect(ctx.liveSession()).toBe(fresh);
    // ...and it is the one that got hydrated with the resumed history.
    // FAILS pre-fix (the code captured ctx.session before connect() and
    // hydrated `original`, leaving the live `fresh` session empty).
    expect(fresh.hydrate).toHaveBeenCalledOnce();
    expect(fresh.hydrate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-resumed', messages }),
    );
    // The detached original is never hydrated.
    expect(original.hydrate).not.toHaveBeenCalled();
  });

  it('a send after resume carries the resumed history (live === hydrated)', async () => {
    // End-to-end on real sessions: prove the reference the view sends through
    // is the hydrated one, by sending on the live session and confirming the
    // resumed history is in the transport payload.
    const resumed: Message[] = [
      { role: 'user', content: 'earlier turn' },
      { role: 'assistant', content: 'earlier reply' },
    ];
    parseMock.mockReturnValue({
      meta: { id: 'conv-send', model: 'claude-sonnet-4-6' },
      messages: resumed,
    });

    const send = vi.fn();
    const makeReal = (): ChatSession =>
      new ChatSession(
        { send } as unknown as import('../transport-interface').SkaldTransport,
        () => 'claude-sonnet-4-6',
        async () => undefined,
        () => ({ provider: 'anthropic' }),
        () => [],
        async () => ({ content: 'ok' }),
        { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() },
      );

    const original = makeReal();
    const fresh = makeReal();
    const ctx = makeCtx({
      content: 'irrelevant — parse is mocked',
      session: original as unknown as FakeSession,
      onConnect: () => fresh as unknown as FakeSession,
    });

    await resumeConversation(fakeFile(), ctx);

    const live = ctx.liveSession() as unknown as ChatSession;
    // The view sends through the live session reference.
    expect(live).toBe(fresh);
    await live.sendUserText('continue');

    // Transport payload must include the resumed history (proving the live
    // session was the hydrated one). Pre-fix, `fresh` was empty so the send
    // would carry only the new "continue" turn.
    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0][0] as { messages?: Message[] };
    const texts = JSON.stringify(payload);
    expect(texts).toContain('earlier turn');
    expect(texts).toContain('earlier reply');
    // The detached original never received the send.
    expect(original.getMessages().some((m) => m.content === 'continue')).toBe(false);
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
    // the session AFTER connect(); here connect() is the no-op default, so the
    // pre-seeded real session stays the live one and is the hydrate target.
    const real = new ChatSession(
      { send: vi.fn() } as unknown as import('../transport-interface').SkaldTransport,
      () => 'claude-sonnet-4-6',
      async () => undefined,
      () => ({ provider: 'anthropic' }),
      () => [],
      async () => ({ content: 'ok' }),
      { onUpdate: vi.fn(), onError: vi.fn(), onDone: vi.fn() },
    );
    // Before resume, the accumulator is zero.
    expect(real.getTotalUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });

    const ctx = makeCtx({
      content: 'irrelevant — parse is mocked',
      session: real as unknown as FakeSession,
    });
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

    expect((ctx.liveSession() as FakeSession).hydrate).not.toHaveBeenCalled();
    expect(ctx.app.workspace.openLinkText).toHaveBeenCalledWith(
      file.path,
      '',
      false,
    );
    // The fallback surfaces a Notice to the user.
    expect(noticeSpy).toHaveBeenCalled();
  });
});
