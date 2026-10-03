/**
 * rewriteOpenRouterTools — server-tool namespace translation, with a
 * focus on carrying the web_fetch domain guard through the rewrite.
 *
 * SECURITY: OpenRouter reads web_fetch options only from the nested
 * `parameters` object, so the allow/deny-list and the fetch cap must land
 * there; a top-level field is silently ignored.
 */
import { describe, expect, it } from 'vitest';
import { rewriteOpenRouterTools } from './openrouter-translate';
import type { ChatRequest } from '@skald/protocol';

function baseReq(tools: ChatRequest['tools']): ChatRequest {
  return {
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1024,
    tools,
  };
}

function rewrittenFetch(tool: Record<string, unknown>): unknown {
  const out = rewriteOpenRouterTools(baseReq([tool as never]));
  return (out.tools ?? []).find(
    (t) => (t as Record<string, unknown>).type === 'openrouter:web_fetch',
  );
}

describe('rewriteOpenRouterTools', () => {
  it('rewrites web_search / web_fetch to the openrouter namespace', () => {
    const out = rewriteOpenRouterTools(
      baseReq([
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
      ]),
    );
    const types = (out.tools ?? []).map(
      (t) => (t as Record<string, unknown>).type,
    );
    expect(types).toContain('openrouter:web_search');
    expect(types).toContain('openrouter:web_fetch');
  });

  it('nests allowed_domains and max_uses under parameters', () => {
    expect(
      rewrittenFetch({
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
      },
    });
  });

  it('nests blocked_domains under parameters', () => {
    expect(
      rewrittenFetch({
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 5,
        blocked_domains: ['evil.example'],
      }),
    ).toEqual({
      type: 'openrouter:web_fetch',
      parameters: { max_uses: 5, blocked_domains: ['evil.example'] },
    });
  });

  it('carries only the cap when no domain list is configured', () => {
    expect(
      rewrittenFetch({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 }),
    ).toEqual({ type: 'openrouter:web_fetch', parameters: { max_uses: 5 } });
  });

  it('omits parameters when there is nothing to carry', () => {
    expect(
      rewrittenFetch({ type: 'web_fetch_20260209', name: 'web_fetch' }),
    ).toEqual({ type: 'openrouter:web_fetch' });
  });

  it('returns the request unchanged when there are no tools', () => {
    const req = baseReq(undefined);
    expect(rewriteOpenRouterTools(req)).toBe(req);
  });
});
