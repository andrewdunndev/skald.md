/**
 * openai-translate: tool-message ordering + orphaned-id synthesis.
 *
 * Two correctness invariants a real OpenAI server enforces:
 *   1. When a single user turn carries BOTH tool_results AND regular content,
 *      the role:'tool' messages must come FIRST (immediately after the
 *      assistant tool_calls turn) — a user message interposed between them 400s.
 *   2. Every assistant tool_call needs an id and every role:'tool' message must
 *      reference it. Orphaned (empty/missing-id) tool_use / tool_result blocks
 *      get deterministic synthesised ids that still MATCH positionally.
 */
import { describe, expect, it } from 'vitest';
import { requestBodyForOpenAI } from './openai-translate';
import type { ChatRequest } from '@skald/protocol';

function baseReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'mistral-7b',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  } as ChatRequest;
}

// ── Message ordering: tool messages BEFORE trailing user content ──────────────
describe('message ordering: tool_result + text in one user turn', () => {
  const mixedReq = baseReq({
    messages: [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_9', name: 'read_note', input: { path: 'n.md' } },
        ] as ChatRequest['messages'][0]['content'],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_9', content: 'the note body' },
          { type: 'text', text: 'now summarise it' },
        ] as ChatRequest['messages'][0]['content'],
      },
    ],
  });

  it('emits the role:tool message IMMEDIATELY after the assistant turn', () => {
    const msgs = (requestBodyForOpenAI(mixedReq).messages) as Array<Record<string, unknown>>;
    const asstIdx = msgs.findIndex((m) => m.role === 'assistant');
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    // The very next message after the assistant tool_calls MUST be the tool reply.
    expect(msgs[asstIdx + 1].role).toBe('tool');
    expect(msgs[asstIdx + 1].tool_call_id).toBe('call_9');
  });

  it('trailing user content comes AFTER the tool message', () => {
    const msgs = (requestBodyForOpenAI(mixedReq).messages) as Array<Record<string, unknown>>;
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    const trailingUserIdx = msgs.findIndex((m, i) => i > toolIdx && m.role === 'user');
    expect(trailingUserIdx).toBeGreaterThan(toolIdx);
    expect(msgs[trailingUserIdx].content).toBe('now summarise it');
  });

  it('no user message is interposed between assistant and tool (the 400 case)', () => {
    const msgs = (requestBodyForOpenAI(mixedReq).messages) as Array<Record<string, unknown>>;
    const asstIdx = msgs.findIndex((m) => m.role === 'assistant');
    const toolIdx = msgs.findIndex((m) => m.role === 'tool');
    const interposed = msgs.slice(asstIdx + 1, toolIdx).some((m) => m.role === 'user');
    expect(interposed).toBe(false);
  });
});

// ── Orphaned tool ids get synthesised stable ids that MATCH ───────────────────
describe('orphaned tool ids: synthesise matching stable ids', () => {
  it('empty assistant tool_use id is replaced with a stable non-empty id', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '', name: 'do_it', input: {} },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const tc = (msgs.find((m) => m.role === 'assistant')?.tool_calls as Array<Record<string, unknown>>)[0];
    expect(typeof tc.id).toBe('string');
    expect((tc.id as string).length).toBeGreaterThan(0);
  });

  it('orphaned tool_use + tool_result (both empty ids) get the SAME synthesised id', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '', name: 'do_it', input: {} },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'result body' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const callId = (msgs.find((m) => m.role === 'assistant')?.tool_calls as Array<Record<string, unknown>>)[0].id;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(callId).toBeTruthy();
    // The assistant call id and the tool reply id MUST match, or OpenAI 400s.
    expect(toolMsg?.tool_call_id).toBe(callId);
  });

  it('two orphaned tool_use/tool_result pairs match positionally (FIFO)', () => {
    const req = baseReq({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: '', name: 'a', input: {} },
            { type: 'tool_use', id: '', name: 'b', input: {} },
          ] as ChatRequest['messages'][0]['content'],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'res a' },
            { type: 'tool_result', content: 'res b' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const callIds = (msgs.find((m) => m.role === 'assistant')?.tool_calls as Array<Record<string, unknown>>)
      .map((t) => t.id as string);
    const toolIds = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id as string);
    expect(callIds).toEqual(toolIds);
    // And the ids are distinct (no collision between the two pairs).
    expect(new Set(callIds).size).toBe(2);
  });

  it('a tool_result with missing tool_use_id still gets a non-empty id', () => {
    const req = baseReq({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'orphan result' },
          ] as ChatRequest['messages'][0]['content'],
        },
      ],
    });
    const msgs = (requestBodyForOpenAI(req).messages) as Array<Record<string, unknown>>;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    expect(typeof toolMsg?.tool_call_id).toBe('string');
    expect((toolMsg?.tool_call_id as string).length).toBeGreaterThan(0);
  });
});
