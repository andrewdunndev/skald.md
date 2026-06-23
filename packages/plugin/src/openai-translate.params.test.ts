/**
 * openai-translate: top-level params, tools, windowed-history, and
 * edge-case tests.
 *
 * Message-block and system-prompt coverage lives in
 * openai-translate.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { requestBodyForOpenAI } from './openai-translate';
import type { ChatRequest } from '@skald/protocol';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'mistral-7b',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  } as ChatRequest;
}

// ── 1. Top-level param translation ───────────────────────────────────────────

describe('top-level param translation', () => {
  it('passes model through unchanged', () => {
    expect(requestBodyForOpenAI(baseReq({ model: 'gpt-4o' })).model).toBe('gpt-4o');
  });

  it('passes max_tokens through', () => {
    expect(requestBodyForOpenAI(baseReq({ max_tokens: 1024 })).max_tokens).toBe(1024);
  });

  it('maps stop_sequences → stop', () => {
    const body = requestBodyForOpenAI(baseReq({ stop_sequences: ['END', 'STOP'] }));
    expect(body.stop).toEqual(['END', 'STOP']);
    expect(body.stop_sequences).toBeUndefined();
  });

  it('omits stop when stop_sequences is empty', () => {
    expect(requestBodyForOpenAI(baseReq({ stop_sequences: [] })).stop).toBeUndefined();
  });

  it('passes temperature when present', () => {
    expect(requestBodyForOpenAI(baseReq({ temperature: 0.7 })).temperature).toBe(0.7);
  });

  it('omits temperature when absent', () => {
    expect(requestBodyForOpenAI(baseReq()).temperature).toBeUndefined();
  });

  it('drops thinking field', () => {
    const body = requestBodyForOpenAI(
      baseReq({ thinking: { type: 'enabled', budget_tokens: 8192 } }),
    );
    expect(body.thinking).toBeUndefined();
  });

  it('drops metadata field', () => {
    const body = requestBodyForOpenAI(baseReq({ metadata: { user_id: 'u1' } }));
    expect(body.metadata).toBeUndefined();
  });
});

// ── 2. Tools translation ──────────────────────────────────────────────────────

describe('tools translation', () => {
  const toolsReq = baseReq({
    tools: [
      {
        name: 'read_note',
        description: 'Read a note',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'write_note',
        description: 'Write a note',
        input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      },
    ] as ChatRequest['tools'],
  });

  it('wraps each tool in {type:"function", function:{...}}', () => {
    const tools = requestBodyForOpenAI(toolsReq).tools as Array<Record<string, unknown>>;
    expect(tools[0].type).toBe('function');
    expect(tools[1].type).toBe('function');
  });

  it('input_schema becomes parameters', () => {
    const tools = requestBodyForOpenAI(toolsReq).tools as Array<Record<string, unknown>>;
    const fn = tools[0].function as Record<string, unknown>;
    expect(fn.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(fn.input_schema).toBeUndefined();
  });

  it('preserves name and description', () => {
    const tools = requestBodyForOpenAI(toolsReq).tools as Array<Record<string, unknown>>;
    const fn = tools[0].function as Record<string, unknown>;
    expect(fn.name).toBe('read_note');
    expect(fn.description).toBe('Read a note');
  });

  it('strips Anthropic server tools (no input_schema)', () => {
    const req = baseReq({
      tools: [
        { name: 'read_note', description: 'Read', input_schema: { type: 'object', properties: {} } },
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ] as ChatRequest['tools'],
    });
    const tools = requestBodyForOpenAI(req).tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect((tools[0].function as Record<string, unknown>).name).toBe('read_note');
  });

  it('omits tools key when all tools are server tools', () => {
    const req = baseReq({
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] as ChatRequest['tools'],
    });
    expect(requestBodyForOpenAI(req).tools).toBeUndefined();
  });

  it('omits tools key when no tools', () => {
    expect(requestBodyForOpenAI(baseReq()).tools).toBeUndefined();
  });
});

// ── 3. Windowed history starting mid-conversation ────────────────────────────

describe('windowed history starting mid-conversation', () => {
  it('handles a window starting with an assistant tool_use without crashing', () => {
    const req = baseReq({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'wc1', name: 'read_note', input: { path: 'z.md' } },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'wc1', content: 'note content' },
          ] as ChatRequest['messages'][0]['content'],
        },
        { role: 'user', content: 'summarize' },
      ],
    });
    expect(() => requestBodyForOpenAI(req)).not.toThrow();
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'tool')?.content).toBe('note content');
  });

  it('handles a window starting with a tool_result user message', () => {
    const req = baseReq({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'wc2', content: 'result from earlier' },
          ] as ChatRequest['messages'][0]['content'],
        },
        { role: 'user', content: 'follow up' },
      ],
    });
    expect(() => requestBodyForOpenAI(req)).not.toThrow();
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'tool')?.content).toBe('result from earlier');
  });
});

// ── 4. Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('tool_use with undefined input serializes to {}', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'e1', name: 'list_notes' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant');
    const fn = ((asst?.tool_calls as Array<Record<string, unknown>>)[0]).function as Record<string, unknown>;
    expect(fn.arguments).toBe('{}');
  });

  it('empty tool_result content becomes empty string', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'e2', name: 'read_note', input: {} },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'e2', content: '' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'tool')?.content).toBe('');
  });

  it('mixed user turn (text + tool_result) emits both user and tool messages', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'e3', name: 'read_note', input: { path: 'n.md' } },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'e3', content: 'note text' },
            { type: 'text', text: 'and here is my follow up text' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'tool')).toBeDefined();
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(2);
  });
});

// ── 5. Thinking-only assistant turn guard ────────────────────────────────────

describe('thinking-only assistant turn guard (Step 3)', () => {
  it('omits an assistant message that has only thinking blocks (no content, no tool_calls)', () => {
    // A turn where the assistant emitted only a <thinking> block is not
    // representable in OpenAI shape (neither content nor tool_calls).
    // The rewriter must skip it rather than push { role:'assistant' }.
    const req = baseReq({
      messages: [
        { role: 'user', content: 'think hard' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '<internal thought>' },
          ] as ChatRequest['messages'][0]['content'],
        },
        { role: 'user', content: 'follow up' },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    // No assistant message should appear — it was thinking-only.
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(0);
    // Both user messages should still be present.
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('emits an assistant message that has only tool_calls (no content) correctly', () => {
    // A tool-only assistant turn is valid in OpenAI shape.
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'c1', name: 'read_note', input: { path: 'x.md' } },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: 'body' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst).toBeDefined();
    // content absent is fine for a tool-only turn.
    expect(asst?.content).toBeUndefined();
    expect(Array.isArray(asst?.tool_calls)).toBe(true);
  });
});
