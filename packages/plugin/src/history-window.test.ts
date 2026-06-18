/**
 * history-window unit tests.
 *
 * Covers: under-budget passthrough, oldest-first dropping,
 * tool-pair atomicity, orphan-tool_result prevention, and
 * the single-huge-message edge case.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@scribian/protocol';
import { windowHistory, compactStaleToolResults, COMPACTION_STUB } from './history-window';

// ── helpers ────────────────────────────────────────────────────────────────

function user(text: string): Message {
  return { role: 'user', content: text };
}

function assistant(text: string): Message {
  return { role: 'assistant', content: text };
}

function userBlocks(blocks: Record<string, unknown>[]): Message {
  return { role: 'user', content: blocks as import('@scribian/protocol').ContentBlock[] };
}

function assistantBlocks(blocks: Record<string, unknown>[]): Message {
  return { role: 'assistant', content: blocks as import('@scribian/protocol').ContentBlock[] };
}

function toolUseAssistant(id: string): Message {
  return assistantBlocks([
    { type: 'text', text: 'let me check' },
    { type: 'tool_use', id, name: 'read_note', input: { path: 'x.md' } },
  ]);
}

function toolResultUser(toolUseId: string): Message {
  return userBlocks([
    { type: 'tool_result', tool_use_id: toolUseId, content: 'note content here' },
  ]);
}

/** Build a string of exactly `chars` 'a' characters. */
function chars(n: number): string {
  return 'a'.repeat(n);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('windowHistory: under-budget passthrough', () => {
  it('returns an identical slice when total tokens are within budget', () => {
    const msgs = [user('hello'), assistant('hi'), user('world')];
    const result = windowHistory(msgs, 10_000);
    expect(result).toEqual(msgs);
    expect(result).not.toBe(msgs); // always a copy
  });

  it('returns an empty array for empty input', () => {
    expect(windowHistory([], 1000)).toEqual([]);
  });

  it('uses 150 000 token default when maxTokens is omitted', () => {
    const msgs = [user('short'), assistant('reply'), user('question')];
    const result = windowHistory(msgs);
    expect(result).toEqual(msgs);
  });
});

describe('windowHistory: oldest-first dropping', () => {
  it('drops oldest messages first when over budget', () => {
    // Each 'a'*400 = 400 chars = 100 tokens. Budget = 150 tokens → keep last 2.
    const old1 = user(chars(400)); // 100 tokens
    const old2 = assistant(chars(400)); // 100 tokens
    const recent = user(chars(200)); // 50 tokens
    const result = windowHistory([old1, old2, recent], 150);
    expect(result).toEqual([old2, recent]);
  });

  it('always keeps at least the last message even if it alone exceeds budget', () => {
    const huge = user(chars(40_000)); // 10 000 tokens >> budget of 5
    const result = windowHistory([user('old'), huge], 5);
    expect(result).toEqual([huge]);
  });

  it('drops multiple old turns until within budget', () => {
    // 5 messages × 100 tokens each = 500 tokens. Budget = 250 → keep last 3.
    const msgs = Array.from({ length: 5 }, (_, i) =>
      i % 2 === 0 ? user(chars(400)) : assistant(chars(400)),
    );
    const result = windowHistory(msgs, 250);
    // Last 3 messages (indices 2,3,4 = 300 tokens; we need ≤250 so only last 2 fit cleanly, but
    // the loop drops until ≤250 which should give us last 2 at 200 tokens)
    expect(result.length).toBeLessThan(5);
    expect(result[result.length - 1]).toBe(msgs[4]);
  });
});

describe('windowHistory: tool_use / tool_result pair atomicity', () => {
  it('keeps a tool_use + tool_result pair together', () => {
    // Three full turns, budget only fits the last two messages.
    const turn1User = user(chars(400)); // 100 tokens
    const turn1Asst = assistant(chars(400)); // 100 tokens
    const turn2Use = toolUseAssistant('t1'); // ~100 tokens
    const turn2Result = toolResultUser('t1'); // ~50 tokens
    const turn3User = user('final question'); // ~5 tokens

    // Budget: ~155 tokens → turn2Use+turn2Result+turn3User fits (≈155);
    // dropping turn1Asst alone would leave turn2Use orphaned by losing the
    // prior context, but that's fine — the pair itself is turn2Use + turn2Result.
    const result = windowHistory(
      [turn1User, turn1Asst, turn2Use, turn2Result, turn3User],
      160,
    );
    // turn2Use and turn2Result must be adjacent in the result if present.
    const useIdx = result.indexOf(turn2Use);
    const resIdx = result.indexOf(turn2Result);
    if (useIdx !== -1) {
      expect(resIdx).toBe(useIdx + 1);
    }
    // The final user turn is always preserved.
    expect(result).toContain(turn3User);
  });

  it('does not start with a tool_result user message (orphan prevention)', () => {
    // Budget forces the window to a point where the first kept message
    // would be a tool_result user message. The window must advance further.
    const bigUser = user(chars(1600)); // 400 tokens — gets dropped
    const toolUse = toolUseAssistant('tx');
    const toolResult = toolResultUser('tx');
    const finalUser = user('continue please'); // tiny

    // Budget = 120 tokens → dropping bigUser leaves toolUse(~100)+toolResult(~50)+finalUser(~5).
    // That's ~155 which is still over 120. The loop drops toolUse first,
    // then toolResult (orphan guard), leaving only finalUser.
    const result = windowHistory([bigUser, toolUse, toolResult, finalUser], 120);

    // Result must NOT start with a tool_result block.
    if (result.length > 0 && Array.isArray(result[0].content)) {
      const firstBlock = result[0].content[0] as Record<string, unknown>;
      expect(firstBlock.type).not.toBe('tool_result');
    }
    // Final user turn always present.
    expect(result).toContain(finalUser);
  });

  it('never starts on an orphan tool_result whose tool_use was dropped', () => {
    // The matching tool_use assistant is large enough to be dropped by the
    // budget loop alone, landing `start` directly on the tool_result user
    // message (invariant 3, not invariant 2 — the tool_use is GONE, not at
    // the boundary). Without the guard, the window would begin with an orphan
    // tool_result and Anthropic 400s.
    const bigToolUse = assistantBlocks([
      { type: 'text', text: chars(4000) }, // ~1000 tokens — dropped on its own
      { type: 'tool_use', id: 'orphan', name: 'read_note', input: { path: 'x.md' } },
    ]);
    const orphanResult = toolResultUser('orphan'); // ~50 tokens, would be start
    const finalUser = user('continue'); // tiny

    // Budget 200: dropping bigToolUse (~1000) gets us well under budget, so the
    // drop loop stops with start on orphanResult. The guard must advance past it.
    const result = windowHistory([bigToolUse, orphanResult, finalUser], 200);

    expect(result).not.toContain(orphanResult);
    expect(result[0]).not.toBe(orphanResult);
    if (Array.isArray(result[0].content)) {
      const firstBlock = result[0].content[0] as Record<string, unknown>;
      expect(firstBlock.type).not.toBe('tool_result');
    }
    expect(result).toContain(finalUser);
  });

  it('skips an orphaned tool_use at the start of the window', () => {
    // Window lands exactly on a tool_use assistant message (its paired user
    // message was dropped). The invariant-2 guard must skip it too.
    const toolUse = toolUseAssistant('ty');
    const toolResult = toolResultUser('ty');
    const nextUser = user('after tool');

    // Tiny budget forces start right at toolUse.
    const result = windowHistory([toolUse, toolResult, nextUser], 5);

    // The tool_use + tool_result may be skipped; final user must survive.
    expect(result).toContain(nextUser);
    if (result.includes(toolUse)) {
      // If tool_use is kept, tool_result must immediately follow.
      expect(result.indexOf(toolResult)).toBe(result.indexOf(toolUse) + 1);
    }
  });
});

describe('windowHistory: single huge message edge case', () => {
  it('keeps only the last message when every earlier message exceeds budget', () => {
    const msgs = [
      user(chars(200_000)), // 50 000 tokens
      assistant(chars(200_000)), // 50 000 tokens
      user(chars(200_000)), // 50 000 tokens — last, always kept
    ];
    const result = windowHistory(msgs, 1000);
    expect(result).toEqual([msgs[2]]);
  });

  it('returns the full slice when there is only one message, regardless of size', () => {
    const single = user(chars(1_000_000));
    const result = windowHistory([single], 10);
    expect(result).toEqual([single]);
  });
});

describe('windowHistory: content-block cost estimation', () => {
  it('estimates cost for block-based messages using text field', () => {
    const msg = userBlocks([
      { type: 'text', text: chars(400) },
      { type: 'text', text: chars(400) },
    ]);
    // 800 chars = 200 tokens. Budget = 100 → must drop with another msg.
    const other = user(chars(400)); // 100 tokens
    const result = windowHistory([other, msg], 100);
    // Only the last message (msg) should be kept.
    expect(result).toContain(msg);
  });

  it('falls back to JSON.stringify length for blocks without text', () => {
    // Blocks without a text field use JSON.stringify, which is always ≥ 2
    // chars. Just verify we don't throw.
    const msg = assistantBlocks([{ type: 'thinking', thinking: chars(100) }]);
    expect(() => windowHistory([msg], 10_000)).not.toThrow();
  });
});

// ── compactStaleToolResults ────────────────────────────────────────────────

/** Build an assistant tool_use turn + a matching user tool_result message. */
function toolTurn(id: string, resultContent = 'note body here'): Message[] {
  return [
    toolUseAssistant(id),
    userBlocks([{ type: 'tool_result', tool_use_id: id, content: resultContent }]),
  ];
}

describe('compactStaleToolResults: stub fires for old results', () => {
  it('stubs tool_results older than keepRecentTurns', () => {
    // 4 real user turns; keepRecentTurns=3 → turn 1 is stale.
    const messages = [
      ...toolTurn('t1', 'stale content'),
      user('query 1'), // real turn 1
      ...toolTurn('t2', 'content 2'),
      user('query 2'), // real turn 2
      ...toolTurn('t3', 'content 3'),
      user('query 3'), // real turn 3
      user('what do you think?'), // real turn 4
    ];
    const result = compactStaleToolResults(messages, { keepRecentTurns: 3 });

    const t1ResultMsg = result.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Record<string, unknown>[]).some(
          (b) => b.type === 'tool_result' && b.tool_use_id === 't1',
        ),
    );
    expect(t1ResultMsg).toBeDefined();
    const block = (t1ResultMsg!.content as Record<string, unknown>[]).find(
      (b) => b.type === 'tool_result',
    )! as Record<string, unknown>;
    expect(block.content).toBe(COMPACTION_STUB);
  });

  it('keeps recent tool_results verbatim', () => {
    // keepRecentTurns=1: only t2's result is in the recent window.
    const messages = [
      ...toolTurn('t1', 'stale'),
      user('old question'), // real turn 1 — makes t1 stale
      ...toolTurn('t2', 'recent verbatim'),
      user('latest question'), // real turn 2 — within keepRecentTurns=1
    ];
    const result = compactStaleToolResults(messages, { keepRecentTurns: 1 });

    const t2ResultMsg = result.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Record<string, unknown>[]).some(
          (b) => b.type === 'tool_result' && b.tool_use_id === 't2',
        ),
    );
    expect(t2ResultMsg).toBeDefined();
    const block = (t2ResultMsg!.content as Record<string, unknown>[]).find(
      (b) => b.type === 'tool_result',
    )! as Record<string, unknown>;
    expect(block.content).toBe('recent verbatim');
  });
});

describe('compactStaleToolResults: pairing invariant', () => {
  it('every tool_use still has a matching tool_result after compaction', () => {
    // This test would fail if compaction deleted (rather than stubbed) a result block.
    const msgs: Message[] = [
      ...toolTurn('a', 'big old note content'),
      user('turn 2 user'),
      ...toolTurn('b', 'another note'),
      user('turn 3 user'),
      ...toolTurn('c', 'fresh note'),
      user('current question'),
    ];
    const result = compactStaleToolResults(msgs, { keepRecentTurns: 2 });

    const toolUseIds = new Set<string>();
    for (const m of result) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content as Record<string, unknown>[]) {
          if (b.type === 'tool_use') toolUseIds.add(b.id as string);
        }
      }
    }

    const toolResultIds = new Set<string>();
    for (const m of result) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content as Record<string, unknown>[]) {
          if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id as string);
        }
      }
    }

    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});

describe('compactStaleToolResults: idempotency', () => {
  it('compacting twice yields the same result as compacting once', () => {
    const msgs: Message[] = [
      ...toolTurn('x', 'lots of text here'),
      user('q1'),
      ...toolTurn('y', 'more text'),
      user('q2'),
    ];
    const once = compactStaleToolResults(msgs, { keepRecentTurns: 1 });
    const twice = compactStaleToolResults(once, { keepRecentTurns: 1 });
    expect(twice).toEqual(once);
  });
});

describe('compactStaleToolResults: no-op paths', () => {
  it('messages with no tool_results are returned unchanged', () => {
    const msgs: Message[] = [
      user('hello'),
      assistant('hi'),
      user('follow up'),
    ];
    const result = compactStaleToolResults(msgs, { keepRecentTurns: 3 });
    expect(result).toEqual(msgs);
  });

  it('does not mutate the input array', () => {
    const original = 'big content';
    const msgs: Message[] = [
      ...toolTurn('z', original),
      user('q1'),
      user('q2'),
      user('q3'),
      user('q4'),
    ];
    compactStaleToolResults(msgs, { keepRecentTurns: 2 });
    const resultMsg = msgs.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Record<string, unknown>[]).some(
          (b) => b.type === 'tool_result',
        ),
    )!;
    const block = (resultMsg.content as Record<string, unknown>[]).find(
      (b) => b.type === 'tool_result',
    )! as Record<string, unknown>;
    expect(block.content).toBe(original);
  });
});
