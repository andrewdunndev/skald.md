import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@scribian/protocol';
import {
  transformOpenRouterEvent,
  transformOpenRouterRequest,
} from './openrouter';

const baseRequest: ChatRequest = {
  model: 'openai/gpt-5.2',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1024,
};

describe('transformOpenRouterRequest', () => {
  it('passes through a request with no tools unchanged', () => {
    expect(transformOpenRouterRequest(baseRequest)).toEqual(baseRequest);
  });

  // The exact outbound tools[] is the OpenRouter wire contract. Each
  // row pins one Anthropic server-tool pin (current + back-compat) to
  // its rewritten openrouter:* form; a regression in the pin match
  // would silently drop server tools for that provider.
  it.each([
    { pin: 'web_search_20260209', name: 'web_search', out: 'openrouter:web_search' },
    { pin: 'web_search_20250305', name: 'web_search', out: 'openrouter:web_search' },
    { pin: 'web_fetch_20260209', name: 'web_fetch', out: 'openrouter:web_fetch' },
    { pin: 'web_fetch_20250910', name: 'web_fetch', out: 'openrouter:web_fetch' },
  ])('rewrites $pin to $out', ({ pin, name, out }) => {
    const result = transformOpenRouterRequest({
      ...baseRequest,
      tools: [{ type: pin, name, max_uses: 5 }],
    });
    expect(result.tools).toEqual([{ type: out }]);
  });

  it('leaves user-defined tools untouched', () => {
    const userTool = {
      name: 'read_note',
      description: 'Read a vault note',
      input_schema: { type: 'object', properties: {} },
    };
    const out = transformOpenRouterRequest({ ...baseRequest, tools: [userTool] });
    expect(out.tools).toEqual([userTool]);
  });

  it('mixes rewritten + pass-through tools in order', () => {
    const out = transformOpenRouterRequest({
      ...baseRequest,
      tools: [
        { name: 'read_note', input_schema: {} },
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { name: 'list_notes', input_schema: {} },
      ],
    });
    expect(out.tools).toEqual([
      { name: 'read_note', input_schema: {} },
      { type: 'openrouter:web_search' },
      { name: 'list_notes', input_schema: {} },
    ]);
  });
});

describe('transformOpenRouterEvent', () => {
  it('passes through unrelated events + text blocks unchanged', () => {
    const data = { index: 0, content_block: { type: 'text', text: 'hello' } };
    expect(transformOpenRouterEvent('content_block_start', data)).toEqual({
      event: 'content_block_start',
      data,
    });
    expect(transformOpenRouterEvent('message_start', { x: 1 })).toEqual({
      event: 'message_start',
      data: { x: 1 },
    });
  });

  // tool_use blocks named openrouter:<tool> are translated to the
  // scribian-canonical server_tool_use shape so the plugin renderer
  // never branches on provider. Each row pins one tool's translation.
  it.each([
    { name: 'openrouter:web_search', tool: 'web_search', input: {} },
    {
      name: 'openrouter:web_fetch',
      tool: 'web_fetch',
      input: { url: 'https://example.com' },
    },
  ])('translates tool_use $name to server_tool_use/$tool', ({ name, tool, input }) => {
    const data = {
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_x', name, input },
    };
    const out = transformOpenRouterEvent('content_block_start', data);
    expect(out.event).toBe('content_block_start');
    expect((out.data as any).content_block).toEqual({
      type: 'server_tool_use',
      id: 'tu_x',
      name: tool,
      input,
    });
  });

  it('translates a openrouter:web_search_result block to web_search_tool_result', () => {
    const data = {
      index: 3,
      content_block: {
        type: 'openrouter:web_search_result',
        tool_use_id: 'tu_xyz',
        content: [{ title: 'hit', url: 'https://example.com' }],
      },
    };
    const out = transformOpenRouterEvent('content_block_start', data);
    expect((out.data as any).content_block.type).toBe('web_search_tool_result');
    expect((out.data as any).content_block.tool_use_id).toBe('tu_xyz');
  });

  it('leaves unrelated tool_use names alone (user-defined tools)', () => {
    const data = {
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tu_read',
        name: 'read_note',
        input: { path: 'foo.md' },
      },
    };
    expect(transformOpenRouterEvent('content_block_start', data).data).toEqual(data);
  });

  it('handles a null data payload without throwing', () => {
    expect(transformOpenRouterEvent('content_block_start', null)).toEqual({
      event: 'content_block_start',
      data: null,
    });
  });
});
