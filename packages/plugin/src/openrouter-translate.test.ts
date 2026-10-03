/**
 * rewriteOpenRouterTools — server-tool namespace translation, with a
 * focus on carrying the web_fetch domain guard through the rewrite.
 *
 * SECURITY: OpenRouter reads server-tool options only from the nested
 * `parameters` object, so the allow/deny-list, the engine pin and the
 * caps must land there; a top-level field is silently ignored.
 */
import { describe, expect, it } from 'vitest';
import { rewriteOpenRouterTools } from './openrouter-translate';
import type { ChatRequest } from './protocol';

function baseReq(tools: ChatRequest['tools']): ChatRequest {
  return {
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1024,
    tools,
  };
}

function rewritten(tool: Record<string, unknown>): unknown {
  const out = rewriteOpenRouterTools(baseReq([tool as never]));
  return (out.tools ?? [])[0];
}

describe('rewriteOpenRouterTools', () => {
  it('rewrites web_search / web_fetch and leaves custom tools alone', () => {
    const custom = { name: 'read_note', description: 'd', input_schema: {} };
    const out = rewriteOpenRouterTools(
      baseReq([
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
        custom as never,
      ]),
    );
    expect(out.tools).toEqual([
      { type: 'openrouter:web_search', parameters: { max_uses: 5 } },
      { type: 'openrouter:web_fetch', parameters: { max_uses: 5 } },
      custom,
    ]);
  });

  it('nests the web_search cap under parameters', () => {
    expect(
      rewritten({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }),
    ).toEqual({ type: 'openrouter:web_search', parameters: { max_uses: 3 } });
  });

  it('omits web_search parameters when there is no cap', () => {
    expect(
      rewritten({ type: 'web_search_20260209', name: 'web_search' }),
    ).toEqual({ type: 'openrouter:web_search' });
  });

  it('pins the openrouter engine when the allow-list is non-empty', () => {
    expect(
      rewritten({
        type: 'web_fetch_20260209',
        name: 'web_fetch',
        max_uses: 5,
        allowed_domains: ['example.com', 'docs.anthropic.com'],
      }),
    ).toEqual({
      type: 'openrouter:web_fetch',
      parameters: {
        max_uses: 5,
        allowed_domains: ['example.com', 'docs.anthropic.com'],
        engine: 'openrouter',
      },
    });
  });

  it('leaves the default engine when the allow-list is empty', () => {
    expect(
      rewritten({
        type: 'web_fetch_20260209',
        name: 'web_fetch',
        max_uses: 5,
        allowed_domains: [],
      }),
    ).toEqual({
      type: 'openrouter:web_fetch',
      parameters: { max_uses: 5, allowed_domains: [] },
    });
  });

  it('carries only the cap when no domain list is configured', () => {
    expect(
      rewritten({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 }),
    ).toEqual({ type: 'openrouter:web_fetch', parameters: { max_uses: 5 } });
  });

  it('omits parameters when there is nothing to carry', () => {
    expect(
      rewritten({ type: 'web_fetch_20260209', name: 'web_fetch' }),
    ).toEqual({ type: 'openrouter:web_fetch' });
  });

  it('returns the request unchanged when there are no tools', () => {
    const req = baseReq(undefined);
    expect(rewriteOpenRouterTools(req)).toBe(req);
  });
});
