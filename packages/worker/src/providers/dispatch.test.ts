/**
 * Provider-dispatch shim tests. dispatchFor is a thin selector: it
 * picks the right url/headers/request-transform/event-translator per
 * provider. The transforms themselves are owned by anthropic.test.ts
 * and openrouter.test.ts — here we only prove the WIRING (that the
 * openrouter branch actually rewrites tools + translates events, that
 * the anthropic branch routes to the Anthropic upstream with x-api-key,
 * and that AI_GATEWAY_URL is threaded). A regression that swaps a
 * branch's translator or url misroutes every chat turn for that
 * provider, and these wiring assertions catch it.
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@scribian/protocol';
import { dispatchFor, resolveProviderKey } from './index';

const BASE_REQUEST: ChatRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1024,
};

describe('dispatchFor: anthropic wiring', () => {
  it('routes to the Anthropic upstream with x-api-key, identity request + event translator', () => {
    const d = dispatchFor('anthropic', 'sk-ant-xxx', {}, BASE_REQUEST);
    expect(d.url).toBe('https://api.anthropic.com/v1/messages');
    expect(d.headers['x-api-key']).toBe('sk-ant-xxx');
    // Anthropic request + events pass through untouched (the identity
    // transform is selected, not the openrouter one).
    expect(d.request).toBe(BASE_REQUEST);
    expect(d.translateEvent('message_start', { foo: 1 })).toEqual({
      event: 'message_start',
      data: { foo: 1 },
    });
  });

  it('threads AI_GATEWAY_URL through to the url + adds cf-aig-metadata', () => {
    const gw = 'https://gw.example/anthropic/v1/messages';
    const d = dispatchFor('anthropic', 'k', { AI_GATEWAY_URL: gw }, BASE_REQUEST);
    expect(d.url).toBe(gw);
    expect(d.headers['cf-aig-metadata']).toBeDefined();
  });
});

describe('dispatchFor: openrouter wiring', () => {
  it('routes to the OpenRouter upstream with Bearer auth (not x-api-key)', () => {
    const d = dispatchFor('openrouter', 'or-xxx', {}, BASE_REQUEST);
    expect(d.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(d.headers['Authorization']).toBe('Bearer or-xxx');
    expect(d.headers['x-api-key']).toBeUndefined();
  });

  it('selects the openrouter request-transform (rewrites server tools)', () => {
    const req: ChatRequest = {
      ...BASE_REQUEST,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    };
    const d = dispatchFor('openrouter', 'k', {}, req);
    expect(d.request.tools).toEqual([{ type: 'openrouter:web_search' }]);
  });

  it('selects the openrouter event-translator (rewrites tool_use names)', () => {
    const d = dispatchFor('openrouter', 'k', {}, BASE_REQUEST);
    const e = d.translateEvent('content_block_start', {
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'tu_abc',
        name: 'openrouter:web_search',
        input: {},
      },
    });
    expect((e.data as any).content_block.type).toBe('server_tool_use');
    expect((e.data as any).content_block.name).toBe('web_search');
  });
});

describe('resolveProviderKey', () => {
  // Plugin-supplied key wins over the Worker secret, trims paste
  // artifacts, treats empty-after-trim as absent, and never
  // cross-resolves between providers. Each row is one allow/fallback
  // path; a regression in precedence or trimming flips the expected key.
  it.each([
    {
      name: 'prefers plugin anthropic key over env secret',
      provider: 'anthropic' as const,
      env: { ANTHROPIC_API_KEY: 'env-key' },
      plugin: { anthropic_api_key: 'plugin-key' },
      expected: 'plugin-key',
    },
    {
      name: 'falls back to env anthropic secret when plugin key absent',
      provider: 'anthropic' as const,
      env: { ANTHROPIC_API_KEY: 'env-key' },
      plugin: {},
      expected: 'env-key',
    },
    {
      name: 'returns undefined when neither anthropic key configured',
      provider: 'anthropic' as const,
      env: {},
      plugin: {},
      expected: undefined,
    },
    {
      name: 'trims whitespace on the plugin anthropic key',
      provider: 'anthropic' as const,
      env: {},
      plugin: { anthropic_api_key: '  sk-ant-xxx  ' },
      expected: 'sk-ant-xxx',
    },
    {
      name: 'treats empty-after-trim plugin key as absent (env wins)',
      provider: 'anthropic' as const,
      env: { ANTHROPIC_API_KEY: 'env-key' },
      plugin: { anthropic_api_key: '   ' },
      expected: 'env-key',
    },
    {
      name: 'routes openrouter independently from anthropic',
      provider: 'openrouter' as const,
      env: { ANTHROPIC_API_KEY: 'anthropic-only', OPENROUTER_API_KEY: 'or-only' },
      plugin: {},
      expected: 'or-only',
    },
    {
      name: 'does not cross-resolve plugin anthropic key as the openrouter key',
      provider: 'openrouter' as const,
      env: {},
      plugin: { anthropic_api_key: 'anthropic-only' },
      expected: undefined,
    },
  ])('$name', ({ provider, env, plugin, expected }) => {
    expect(resolveProviderKey(provider, env, plugin)).toBe(expected);
  });
});
