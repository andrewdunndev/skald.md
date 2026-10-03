/**
 * openai-translate: message-translation tests (system + message blocks).
 *
 * Top-level param, tools, and edge-case coverage lives in
 * openai-translate.params.test.ts to stay within the 400-line cap.
 */
import { describe, expect, it } from 'vitest';
import { requestBodyForOpenAI } from './openai-translate';
import type { ChatRequest } from './protocol';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'mistral-7b',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  } as ChatRequest;
}

// ── 1. System prompt ──────────────────────────────────────────────────────────

describe('system: string', () => {
  it('emits a leading system message with the string content', () => {
    const body = requestBodyForOpenAI(baseReq({ system: 'You are helpful.' }));
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('omits the system message when system is empty string', () => {
    const body = requestBodyForOpenAI(baseReq({ system: '' }));
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).not.toBe('system');
  });

  it('omits the system message when system is undefined', () => {
    const body = requestBodyForOpenAI(baseReq());
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].role).not.toBe('system');
  });
});

describe('system: block array', () => {
  it('concatenates text blocks with \\n\\n', () => {
    const body = requestBodyForOpenAI(
      baseReq({
        system: [
          { type: 'text', text: 'Part one.' },
          { type: 'text', text: 'Part two.' },
        ] as ChatRequest['system'],
      }),
    );
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'Part one.\n\nPart two.' });
  });

  it('strips cache_control from system blocks', () => {
    const body = requestBodyForOpenAI(
      baseReq({
        system: [
          { type: 'text', text: 'cached system', cache_control: { type: 'ephemeral' } },
        ] as ChatRequest['system'],
      }),
    );
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[0].content).toBe('cached system');
    expect(JSON.stringify(msgs[0])).not.toContain('cache_control');
  });
});

// ── 2. Plain text user / assistant round ──────────────────────────────────────

describe('plain text user/assistant', () => {
  it('passes user text through as a plain string content', () => {
    const body = requestBodyForOpenAI(baseReq({ messages: [{ role: 'user', content: 'hi' }] }));
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'user')?.content).toBe('hi');
  });

  it('passes assistant text through as content string', () => {
    const body = requestBodyForOpenAI(
      baseReq({
        messages: [
          { role: 'user', content: 'question' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'answer' }] as ChatRequest['messages'][0]['content'],
          },
        ],
      }),
    );
    const msgs = body.messages as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('answer');
    expect(asst?.tool_calls).toBeUndefined();
  });
});

// ── 3. Image → data: URL in content parts ─────────────────────────────────────

describe('user message with image block', () => {
  const imageReq = baseReq({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ] as ChatRequest['messages'][0]['content'],
      },
    ],
  });

  it('converts to content-parts array', () => {
    const body = requestBodyForOpenAI(imageReq);
    const msgs = body.messages as Array<Record<string, unknown>>;
    const user = msgs.find((m) => m.role === 'user');
    expect(Array.isArray(user?.content)).toBe(true);
    expect((user?.content as unknown[]).length).toBe(2);
  });

  it('text part is {type:text, text:...}', () => {
    const body = requestBodyForOpenAI(imageReq);
    const msgs = body.messages as Array<Record<string, unknown>>;
    const parts = msgs.find((m) => m.role === 'user')?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('image part has data: URL', () => {
    const body = requestBodyForOpenAI(imageReq);
    const msgs = body.messages as Array<Record<string, unknown>>;
    const parts = msgs.find((m) => m.role === 'user')?.content as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } });
  });

  it('text-only user messages use a plain string (not parts)', () => {
    const body = requestBodyForOpenAI(baseReq({ messages: [{ role: 'user', content: 'text only' }] }));
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(typeof msgs.find((m) => m.role === 'user')?.content).toBe('string');
  });
});

// ── 4. Single tool call ───────────────────────────────────────────────────────

describe('single tool call', () => {
  const toolReq = baseReq({
    messages: [
      { role: 'user', content: 'read my note' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'read_note', input: { path: 'journal.md' } },
        ] as ChatRequest['messages'][0]['content'],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'note body' },
        ] as ChatRequest['messages'][0]['content'],
      },
    ],
  });

  it('assistant message has tool_calls', () => {
    const msgs = (requestBodyForOpenAI(toolReq).messages) as Array<Record<string, unknown>>;
    expect(Array.isArray(msgs.find((m) => m.role === 'assistant')?.tool_calls)).toBe(true);
  });

  it('tool_call has correct shape and arguments as a JSON string', () => {
    const msgs = (requestBodyForOpenAI(toolReq).messages) as Array<Record<string, unknown>>;
    const tc = (msgs.find((m) => m.role === 'assistant')?.tool_calls as Array<Record<string, unknown>>)[0];
    expect(tc.id).toBe('call_1');
    expect(tc.type).toBe('function');
    const fn = tc.function as Record<string, unknown>;
    expect(fn.name).toBe('read_note');
    expect(fn.arguments).toBe(JSON.stringify({ path: 'journal.md' }));
    expect(typeof fn.arguments).toBe('string');
  });

  it('tool result becomes a role:tool message', () => {
    const msgs = (requestBodyForOpenAI(toolReq).messages) as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call_1');
    expect(toolMsg?.content).toBe('note body');
  });

  it('no user message is emitted for the tool_result-only turn', () => {
    const msgs = (requestBodyForOpenAI(toolReq).messages) as Array<Record<string, unknown>>;
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

// ── 5. Parallel tool calls ────────────────────────────────────────────────────

describe('parallel tool calls', () => {
  const parallelReq = baseReq({
    messages: [
      { role: 'user', content: 'compare two notes' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'c1', name: 'read_note', input: { path: 'a.md' } },
          { type: 'tool_use', id: 'c2', name: 'read_note', input: { path: 'b.md' } },
        ] as ChatRequest['messages'][0]['content'],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'body of a' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'body of b' },
        ] as ChatRequest['messages'][0]['content'],
      },
    ],
  });

  it('assistant message has two tool_calls', () => {
    const msgs = (requestBodyForOpenAI(parallelReq).messages) as Array<Record<string, unknown>>;
    expect((msgs.find((m) => m.role === 'assistant')?.tool_calls as unknown[]).length).toBe(2);
  });

  it('each tool_result explodes into a separate role:tool message', () => {
    const msgs = (requestBodyForOpenAI(parallelReq).messages) as Array<Record<string, unknown>>;
    expect(msgs.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('tool messages carry correct tool_call_ids', () => {
    const msgs = (requestBodyForOpenAI(parallelReq).messages) as Array<Record<string, unknown>>;
    const ids = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(ids).toContain('c1');
    expect(ids).toContain('c2');
  });

  it('no stray user message is emitted for the parallel results turn', () => {
    const msgs = (requestBodyForOpenAI(parallelReq).messages) as Array<Record<string, unknown>>;
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1);
  });
});

// ── 6. Mixed turn: assistant text + tool_use ──────────────────────────────────

describe('mixed assistant turn (text + tool_use)', () => {
  it('assistant message has both content and tool_calls', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'check the note' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me look that up.' },
            { type: 'tool_use', id: 'cx', name: 'read_note', input: { path: 'x.md' } },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('Let me look that up.');
    expect((asst?.tool_calls as unknown[]).length).toBe(1);
  });
});

// ── 7. tool_result with block content ─────────────────────────────────────────

describe('tool_result with block content (not string)', () => {
  it('joins text blocks with \\n\\n in the tool message', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'b1', name: 'search_vault', input: { query: 'foo' } },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              content: [
                { type: 'text', text: 'result line one' },
                { type: 'text', text: 'result line two' },
              ],
            },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'tool')?.content).toBe('result line one\n\nresult line two');
  });

  it('non-text blocks in tool_result are JSON-stringified', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'b2', name: 'web_fetch', input: {} },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'b2', content: [{ type: 'document', data: 'pdf stuff' }] },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    expect(msgs.find((m) => m.role === 'tool')?.content as string).toContain('"type":"document"');
  });
});

// ── 8. Thinking + redacted_thinking blocks dropped ────────────────────────────

describe('thinking and redacted_thinking blocks dropped', () => {
  it('thinking block in assistant turn is omitted', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'think about it' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '<internal thought>' },
            { type: 'text', text: 'Here is my answer.' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('Here is my answer.');
    expect(JSON.stringify(asst)).not.toContain('thinking');
  });

  it('redacted_thinking block in assistant turn is dropped', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'think' },
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'REDACTED' },
            { type: 'text', text: 'answer' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('answer');
    expect(JSON.stringify(asst)).not.toContain('redacted_thinking');
  });
});
