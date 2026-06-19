import { describe, expect, it } from 'vitest';
import { applyAnthropicCaching } from './anthropic-caching';
import {
  compactStaleToolResults,
  COMPACTION_STUB,
  COMPACTION_TOKEN_THRESHOLD,
} from './history-window';
import type { ChatRequest, Message } from '@skald/protocol';

function baseReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  } as ChatRequest;
}

describe('applyAnthropicCaching', () => {
  it('wraps a string system into a text block with a 1-hour cache_control', () => {
    const out = applyAnthropicCaching(baseReq({ system: 'you are helpful' }));
    expect(Array.isArray(out.system)).toBe(true);
    const block = (out.system as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe('text');
    expect(block.text).toBe('you are helpful');
    expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('puts a 1-hour cache_control on the last tool', () => {
    const out = applyAnthropicCaching(
      baseReq({
        tools: [
          { name: 'a', description: 'a', input_schema: { type: 'object' } },
          { name: 'b', description: 'b', input_schema: { type: 'object' } },
        ] as unknown as ChatRequest['tools'],
      }),
    );
    const tools = out.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('leaves an empty system / tools-less request untouched', () => {
    const out = applyAnthropicCaching(baseReq({ system: '' }));
    expect(out.system).toBe('');
    expect(out.tools).toBeUndefined();
  });

  // ── Moving history breakpoint (3rd breakpoint) ──────────────────────────

  it('places a cache_control on the last block of the second-to-last message when >= 2 messages', () => {
    const out = applyAnthropicCaching(
      baseReq({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first turn' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'assistant reply' }] },
          { role: 'user', content: 'new message' },
        ] as ChatRequest['messages'],
      }),
    );
    // second-to-last message is index 1 (the assistant reply)
    const msgs = out.messages as unknown as Array<Record<string, unknown>>;
    const priorContent = msgs[1].content as Array<Record<string, unknown>>;
    expect(priorContent[priorContent.length - 1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    // newest user message (index 2) must NOT have a cache breakpoint added
    const newestContent = msgs[2].content;
    if (Array.isArray(newestContent)) {
      expect(
        (newestContent[newestContent.length - 1] as Record<string, unknown>).cache_control,
      ).toBeUndefined();
    }
  });

  it('does NOT place the history breakpoint when only 1 message', () => {
    const out = applyAnthropicCaching(
      baseReq({
        messages: [{ role: 'user', content: 'only message' }] as ChatRequest['messages'],
      }),
    );
    const msgs = out.messages as unknown as Array<Record<string, unknown>>;
    // Single message — nothing should be modified for the history breakpoint.
    const content = msgs[0].content;
    if (Array.isArray(content)) {
      expect(
        (content[content.length - 1] as Record<string, unknown>).cache_control,
      ).toBeUndefined();
    } else {
      // String content unchanged (no wrapping on single-message path).
      expect(typeof content).toBe('string');
    }
  });

  it('wraps string-content prior-turn message into a text block with cache_control', () => {
    const out = applyAnthropicCaching(
      baseReq({
        messages: [
          { role: 'user', content: 'prior turn string' },
          { role: 'user', content: 'newest message' },
        ] as ChatRequest['messages'],
      }),
    );
    const msgs = out.messages as unknown as Array<Record<string, unknown>>;
    // Prior message (index 0) had string content — must now be an array.
    const priorContent = msgs[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(priorContent)).toBe(true);
    expect(priorContent[0].type).toBe('text');
    expect(priorContent[0].text).toBe('prior turn string');
    expect(priorContent[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('keeps total breakpoints at or below 4 with system + tools + history', () => {
    const out = applyAnthropicCaching(
      baseReq({
        system: 'sys',
        tools: [
          { name: 'a', description: 'a', input_schema: { type: 'object' } },
        ] as unknown as ChatRequest['tools'],
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ] as ChatRequest['messages'],
      }),
    );

    // Count all cache_control occurrences across system, tools, and messages.
    let count = 0;
    const sys = out.system as Array<Record<string, unknown>> | string | undefined;
    if (Array.isArray(sys)) {
      for (const b of sys) if (b.cache_control) count++;
    }
    const tools = out.tools as Array<Record<string, unknown>> | undefined;
    if (tools) {
      for (const t of tools) if (t.cache_control) count++;
    }
    const msgs = out.messages as unknown as Array<Record<string, unknown>>;
    for (const m of msgs) {
      const c = m.content;
      if (Array.isArray(c)) {
        for (const b of c as Array<Record<string, unknown>>) {
          if (b.cache_control) count++;
        }
      }
    }
    expect(count).toBeLessThanOrEqual(4);
  });
});

// ── compaction × caching cooperation (size-triggered) ───────────────────────
//
// The dispatch path runs compactStaleToolResults(...) and then (on the
// Anthropic path) applyAnthropicCaching(...). These tests assert the two
// features cooperate: below the threshold compaction is a no-op so the
// cached prefix lands on REAL content; above it, stubbing fires.

/** assistant tool_use turn + matching user tool_result message. */
function toolTurn(id: string, body: string): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'read_note', input: { path: 'x.md' } },
      ] as unknown as Message['content'],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: body },
      ] as unknown as Message['content'],
    },
  ];
}

/** True when any tool_result block in the list carries the stub text. */
function hasStub(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Record<string, unknown>[]).some(
        (b) => b.type === 'tool_result' && b.content === COMPACTION_STUB,
      ),
  );
}

describe('compaction × caching: short history (under threshold)', () => {
  it('leaves tool_results verbatim so the cache breakpoint lands on real content', () => {
    // Small tool turns, but with MORE than the default keepRecentTurns (3)
    // real-user-turns so that t1's result is "stale" by turn count. The
    // ONLY reason it isn't stubbed is the size gate — total chars are well
    // under COMPACTION_TOKEN_THRESHOLD. This is what makes the mutation
    // (gate removed) observable: without the gate, t1 would be stubbed.
    const history: Message[] = [
      ...toolTurn('t1', 'small note one'),
      { role: 'user', content: 'q1' },
      ...toolTurn('t2', 'small note two'),
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'q3' },
      { role: 'user', content: 'q4' },
      { role: 'user', content: 'newest question' },
    ];
    const compacted = compactStaleToolResults(history);

    // No stub anywhere — full content preserved → stable cached prefix.
    // Passes on correct code; FAILS under mutation "compaction always-on"
    // (drop the threshold gate) because t1's result would be stubbed and
    // land inside the cached prefix, churning the cache every turn.
    expect(hasStub(compacted)).toBe(false);

    const out = applyAnthropicCaching({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: compacted,
    } as ChatRequest);

    // The breakpoint sits on the prior turn (second-to-last message). With
    // no compaction that message holds its real content, not a stub.
    const msgs = out.messages as unknown as Array<Record<string, unknown>>;
    const prior = msgs[msgs.length - 2];
    const priorContent = prior.content as Array<Record<string, unknown>> | string;
    if (Array.isArray(priorContent)) {
      const last = priorContent[priorContent.length - 1];
      expect(last.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(last.content).not.toBe(COMPACTION_STUB);
    }
  });
});

describe('compaction × caching: large history (over threshold)', () => {
  it('stubs stale tool_results once history exceeds the threshold', () => {
    // One oversized stale tool_result pushes the estimate past the
    // threshold; default keepRecentTurns=3 keeps the tail verbatim.
    const big = 'x'.repeat(COMPACTION_TOKEN_THRESHOLD * 4 + 8); // > threshold in tokens
    const history: Message[] = [
      ...toolTurn('stale', big),
      { role: 'user', content: 'q1' },
      ...toolTurn('r1', 'recent one'),
      { role: 'user', content: 'q2' },
      ...toolTurn('r2', 'recent two'),
      { role: 'user', content: 'q3' },
      { role: 'user', content: 'newest' },
    ];
    const compacted = compactStaleToolResults(history);

    // Stubbing fires for the stale turn. Passes on correct code; would
    // FAIL under mutation "never compact" (always return verbatim).
    expect(hasStub(compacted)).toBe(true);
    const staleMsg = compacted.find(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Record<string, unknown>[]).some(
          (b) => b.type === 'tool_result' && b.tool_use_id === 'stale',
        ),
    )!;
    const block = (staleMsg.content as Record<string, unknown>[]).find(
      (b) => b.type === 'tool_result',
    )!;
    expect(block.content).toBe(COMPACTION_STUB);
  });
});
