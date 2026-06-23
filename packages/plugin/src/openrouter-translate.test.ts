/**
 * rewriteOpenRouterTools — server-tool namespace translation, with a
 * focus on carrying the web_fetch domain guard through the rewrite.
 *
 * SECURITY: the web_fetch allow-list is the exfiltration defense on the
 * Anthropic path. On OpenRouter the on/off gate is load-bearing (OR does
 * not enforce allowed_domains today), but the rewrite must still forward
 * the operator's allow/deny-list rather than silently discarding it.
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

  it('forwards allowed_domains through the web_fetch rewrite', () => {
    const out = rewriteOpenRouterTools(
      baseReq([
        {
          type: 'web_fetch_20260209',
          name: 'web_fetch',
          max_uses: 5,
          allowed_domains: ['example.com', 'docs.anthropic.com'],
        },
      ]),
    );
    const webFetch = (out.tools ?? []).find(
      (t) => (t as Record<string, unknown>).type === 'openrouter:web_fetch',
    ) as Record<string, unknown> | undefined;
    expect(webFetch?.allowed_domains).toEqual([
      'example.com',
      'docs.anthropic.com',
    ]);
  });

  it('forwards blocked_domains through the web_fetch rewrite', () => {
    const out = rewriteOpenRouterTools(
      baseReq([
        {
          type: 'web_fetch_20260209',
          name: 'web_fetch',
          max_uses: 5,
          blocked_domains: ['evil.example'],
        },
      ]),
    );
    const webFetch = (out.tools ?? []).find(
      (t) => (t as Record<string, unknown>).type === 'openrouter:web_fetch',
    ) as Record<string, unknown> | undefined;
    expect(webFetch?.blocked_domains).toEqual(['evil.example']);
  });

  it('omits the domain keys when none are configured', () => {
    const out = rewriteOpenRouterTools(
      baseReq([{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 }]),
    );
    const webFetch = (out.tools ?? []).find(
      (t) => (t as Record<string, unknown>).type === 'openrouter:web_fetch',
    ) as Record<string, unknown> | undefined;
    expect(webFetch).toBeDefined();
    expect(webFetch?.allowed_domains).toBeUndefined();
    expect(webFetch?.blocked_domains).toBeUndefined();
  });

  it('returns the request unchanged when there are no tools', () => {
    const req = baseReq(undefined);
    expect(rewriteOpenRouterTools(req)).toBe(req);
  });
});
