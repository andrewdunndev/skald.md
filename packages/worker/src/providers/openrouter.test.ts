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

  it('rewrites the Anthropic web_search server tool to the OpenRouter form', () => {
    const out = transformOpenRouterRequest({
      ...baseRequest,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      ],
    });
    expect(out.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  it('rewrites the Anthropic web_fetch server tool to the OpenRouter form', () => {
    const out = transformOpenRouterRequest({
      ...baseRequest,
      tools: [
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
      ],
    });
    expect(out.tools).toEqual([{ type: 'openrouter:web_fetch' }]);
  });

  it('leaves user-defined tools untouched', () => {
    const userTool = {
      name: 'read_note',
      description: 'Read a vault note',
      input_schema: { type: 'object', properties: {} },
    };
    const out = transformOpenRouterRequest({
      ...baseRequest,
      tools: [userTool],
    });
    expect(out.tools).toEqual([userTool]);
  });

  it('mixes rewritten + pass-through tools in order', () => {
    const out = transformOpenRouterRequest({
      ...baseRequest,
      tools: [
        { name: 'read_note', input_schema: {} },
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        { name: 'list_notes', input_schema: {} },
      ],
    });
    expect(out.tools).toHaveLength(3);
    expect(out.tools![0]).toEqual({ name: 'read_note', input_schema: {} });
    expect(out.tools![1]).toEqual({ type: 'openrouter:web_search' });
    expect(out.tools![2]).toEqual({ name: 'list_notes', input_schema: {} });
  });
});

describe('transformOpenRouterEvent', () => {
  it('passes through events on unrelated event names', () => {
    const data = { content_block: { type: 'text', text: 'hello' } };
    expect(transformOpenRouterEvent('message_start', data)).toEqual({
      event: 'message_start',
      data,
    });
  });

  it('passes through content_block_start with a text block unchanged', () => {
    const data = {
      index: 0,
      content_block: { type: 'text', text: '' },
    };
    expect(transformOpenRouterEvent('content_block_start', data)).toEqual({
      event: 'content_block_start',
      data,
    });
  });

  it('translates a tool_use block named openrouter:web_search to server_tool_use/web_search', () => {
    const data = {
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'tu_xyz',
        name: 'openrouter:web_search',
        input: {},
      },
    };
    const out = transformOpenRouterEvent('content_block_start', data);
    expect(out.event).toBe('content_block_start');
    expect((out.data as any).content_block).toEqual({
      type: 'server_tool_use',
      id: 'tu_xyz',
      name: 'web_search',
      input: {},
    });
  });

  it('translates a tool_use block named openrouter:web_fetch to server_tool_use/web_fetch', () => {
    const data = {
      index: 2,
      content_block: {
        type: 'tool_use',
        id: 'tu_fetch',
        name: 'openrouter:web_fetch',
        input: { url: 'https://example.com' },
      },
    };
    const out = transformOpenRouterEvent('content_block_start', data);
    expect((out.data as any).content_block.type).toBe('server_tool_use');
    expect((out.data as any).content_block.name).toBe('web_fetch');
    expect((out.data as any).content_block.input).toEqual({
      url: 'https://example.com',
    });
  });

  it('translates a tool_result block type openrouter:web_search_result to web_search_tool_result', () => {
    const data = {
      index: 3,
      content_block: {
        type: 'openrouter:web_search_result',
        tool_use_id: 'tu_xyz',
        content: [
          { title: 'hit', url: 'https://example.com' },
        ],
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
    const out = transformOpenRouterEvent('content_block_start', data);
    expect(out.data).toEqual(data);
  });

  it('handles a null data payload without throwing', () => {
    expect(transformOpenRouterEvent('content_block_start', null)).toEqual({
      event: 'content_block_start',
      data: null,
    });
  });
});
