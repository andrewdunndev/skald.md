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
});
