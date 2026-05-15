/**
 * Provider-dispatch shim tests. Verifies dispatchFor wires the right
 * upstream URL, headers, request shape, and event translator for each
 * provider — the seam that decides Anthropic-direct vs OpenRouter-
 * fallback. A regression here misroutes every chat turn for the
 * affected provider.
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@scribian/protocol';
import { dispatchFor, resolveProviderKey } from './index';

const BASE_REQUEST: ChatRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1024,
};

describe('dispatchFor: anthropic', () => {
  it('routes to api.anthropic.com/v1/messages with the API key as x-api-key', () => {
    const d = dispatchFor('anthropic', 'sk-ant-xxx', {}, BASE_REQUEST);
    expect(d.url).toBe('https://api.anthropic.com/v1/messages');
    expect(d.headers['x-api-key']).toBe('sk-ant-xxx');
  });

  it('passes the request through unchanged for Anthropic', () => {
    const d = dispatchFor('anthropic', 'k', {}, BASE_REQUEST);
    expect(d.request).toBe(BASE_REQUEST);
  });

  it('translates events as identity for Anthropic', () => {
    const d = dispatchFor('anthropic', 'k', {}, BASE_REQUEST);
    const e = d.translateEvent('message_start', { foo: 1 });
    expect(e).toEqual({ event: 'message_start', data: { foo: 1 } });
  });

  it('switches URL + adds cf-aig-metadata when AI_GATEWAY_URL is set', () => {
    const gw = 'https://gw.example/anthropic/v1/messages';
    const d = dispatchFor(
      'anthropic',
      'k',
      { AI_GATEWAY_URL: gw },
      BASE_REQUEST,
    );
    expect(d.url).toBe(gw);
    expect(d.headers['cf-aig-metadata']).toBeDefined();
  });
});

describe('dispatchFor: openrouter', () => {
  it('routes to openrouter.ai/api/v1/messages with Bearer auth', () => {
    const d = dispatchFor('openrouter', 'or-xxx', {}, BASE_REQUEST);
    expect(d.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(d.headers['Authorization']).toBe('Bearer or-xxx');
  });

  it('does NOT send anthropic-version (different upstream contract)', () => {
    const d = dispatchFor('openrouter', 'k', {}, BASE_REQUEST);
    expect(d.headers['anthropic-version']).toBeUndefined();
    expect(d.headers['x-api-key']).toBeUndefined();
  });

  it('rewrites Anthropic-shaped server tools to openrouter:* form', () => {
    const req: ChatRequest = {
      ...BASE_REQUEST,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      ],
    };
    const d = dispatchFor('openrouter', 'k', {}, req);
    expect(d.request.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  it('uses the openrouter-aware event translator (rewrites tool_use names)', () => {
    const d = dispatchFor('openrouter', 'k', {}, BASE_REQUEST);
    const inEvent = d.translateEvent('content_block_start', {
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'tu_abc',
        name: 'openrouter:web_search',
        input: {},
      },
    });
    // OpenRouter's `tool_use` for server tools is translated to
    // scribian-canonical `server_tool_use` so the plugin renderer
    // doesn't branch on provider.
    expect((inEvent.data as any).content_block.type).toBe('server_tool_use');
    expect((inEvent.data as any).content_block.name).toBe('web_search');
  });
});

describe('resolveProviderKey', () => {
  it('prefers plugin-supplied anthropic key over the Worker secret', () => {
    expect(
      resolveProviderKey(
        'anthropic',
        { ANTHROPIC_API_KEY: 'env-key' },
        { anthropic_api_key: 'plugin-key' },
      ),
    ).toBe('plugin-key');
  });

  it('falls back to the Worker secret when plugin key is absent', () => {
    expect(
      resolveProviderKey('anthropic', { ANTHROPIC_API_KEY: 'env-key' }, {}),
    ).toBe('env-key');
  });

  it('returns undefined when neither is configured', () => {
    expect(resolveProviderKey('anthropic', {}, {})).toBeUndefined();
  });

  it('trims whitespace on the plugin-supplied key (settings paste artifacts)', () => {
    expect(
      resolveProviderKey(
        'anthropic',
        {},
        { anthropic_api_key: '  sk-ant-xxx  ' },
      ),
    ).toBe('sk-ant-xxx');
  });

  it('treats an empty-after-trim plugin key as absent', () => {
    expect(
      resolveProviderKey(
        'anthropic',
        { ANTHROPIC_API_KEY: 'env-key' },
        { anthropic_api_key: '   ' },
      ),
    ).toBe('env-key');
  });

  it('routes openrouter independently from anthropic', () => {
    expect(
      resolveProviderKey(
        'openrouter',
        {
          ANTHROPIC_API_KEY: 'anthropic-only',
          OPENROUTER_API_KEY: 'or-only',
        },
        {},
      ),
    ).toBe('or-only');
  });

  it('does not cross-resolve plugin keys between providers', () => {
    // anthropic_api_key must NOT be used as the openrouter key.
    expect(
      resolveProviderKey(
        'openrouter',
        {},
        { anthropic_api_key: 'anthropic-only' },
      ),
    ).toBeUndefined();
  });
});
