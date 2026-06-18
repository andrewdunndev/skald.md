import { describe, expect, it } from 'vitest';
import { applyAnthropicCaching } from './anthropic-caching';
import type { ChatRequest } from '@scribian/protocol';

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
