/**
 * serverToolsForModel unit tests.
 *
 * Ensures the correct Anthropic server-tool version pins are selected
 * per model id. Haiku models must receive the older 20250305/20250910
 * pins; all other models must receive the current 20260209 pins.
 */
import { describe, expect, it } from 'vitest';
import { serverToolsForModel, applyWebFetchAllowlist } from './server';
import type { ToolDefinition } from '@skald/protocol';

function webFetchOf(tools: ReturnType<typeof serverToolsForModel>) {
  return tools.find((d) => (d as Record<string, unknown>).name === 'web_fetch') as
    | Record<string, unknown>
    | undefined;
}
function webSearchOf(tools: ReturnType<typeof serverToolsForModel>) {
  return tools.find((d) => (d as Record<string, unknown>).name === 'web_search') as
    | Record<string, unknown>
    | undefined;
}

function toolType(tools: ReturnType<typeof serverToolsForModel>, name: string): string {
  const t = tools.find((d) => d.name === name);
  if (!t) throw new Error(`tool "${name}" not found`);
  return (t as Record<string, unknown>).type as string;
}

describe('serverToolsForModel', () => {
  it('haiku model gets 20250305 web_search pin', () => {
    expect(toolType(serverToolsForModel('claude-haiku-4-5'), 'web_search')).toBe(
      'web_search_20250305',
    );
  });

  it('haiku model gets 20250910 web_fetch pin', () => {
    expect(toolType(serverToolsForModel('claude-haiku-4-5'), 'web_fetch')).toBe(
      'web_fetch_20250910',
    );
  });

  it('sonnet model gets 20260209 web_search pin', () => {
    expect(toolType(serverToolsForModel('claude-sonnet-4-6'), 'web_search')).toBe(
      'web_search_20260209',
    );
  });

  it('opus model gets 20260209 web_fetch pin', () => {
    expect(toolType(serverToolsForModel('claude-opus-4-5'), 'web_fetch')).toBe(
      'web_fetch_20260209',
    );
  });

  it('future haiku point release still matches (regex robustness)', () => {
    expect(toolType(serverToolsForModel('claude-haiku-4-5-20251001'), 'web_search')).toBe(
      'web_search_20250305',
    );
  });

  it('empty model string defaults to 20260209 pins', () => {
    expect(toolType(serverToolsForModel(''), 'web_search')).toBe(
      'web_search_20260209',
    );
  });

  it('max_uses is 5 for all models', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-6', '']) {
      const tools = serverToolsForModel(model);
      for (const t of tools) {
        expect((t as Record<string, unknown>).max_uses).toBe(5);
      }
    }
  });

  it('does not mutate the shared tool definitions when no guard is given', () => {
    const a = serverToolsForModel('claude-sonnet-4-6');
    const b = serverToolsForModel('claude-sonnet-4-6');
    // No guard → same backing array is acceptable, but a guarded call must
    // never have leaked an allowed_domains key onto it.
    expect(webFetchOf(a)?.allowed_domains).toBeUndefined();
    expect(webFetchOf(b)?.allowed_domains).toBeUndefined();
  });
});

describe('serverToolsForModel — web_fetch domain guard', () => {
  it('sets allowed_domains on web_fetch from the guard', () => {
    const tools = serverToolsForModel('claude-sonnet-4-6', {
      allowedDomains: ['example.com', 'docs.anthropic.com'],
    });
    expect(webFetchOf(tools)?.allowed_domains).toEqual([
      'example.com',
      'docs.anthropic.com',
    ]);
  });

  it('does NOT set allowed_domains on web_search (fetch-only guard)', () => {
    const tools = serverToolsForModel('claude-sonnet-4-6', {
      allowedDomains: ['example.com'],
    });
    expect(webSearchOf(tools)?.allowed_domains).toBeUndefined();
    expect(webSearchOf(tools)?.blocked_domains).toBeUndefined();
  });

  it('applies the guard to haiku pins too', () => {
    const tools = serverToolsForModel('claude-haiku-4-5', {
      allowedDomains: ['example.com'],
    });
    // Still the older haiku pin...
    expect(webFetchOf(tools)?.type).toBe('web_fetch_20250910');
    // ...with the allow-list applied.
    expect(webFetchOf(tools)?.allowed_domains).toEqual(['example.com']);
  });

  it('trims, drops empties, and de-dupes the domain list', () => {
    const tools = serverToolsForModel('claude-sonnet-4-6', {
      allowedDomains: ['  example.com ', '', 'example.com', '   ', 'b.com'],
    });
    expect(webFetchOf(tools)?.allowed_domains).toEqual(['example.com', 'b.com']);
  });

  it('omits the restriction entirely when the list normalizes to empty', () => {
    // An empty allowed_domains would be read by Anthropic as "allow
    // nothing" and silently break every fetch — the guard must instead
    // leave the key off so the on/off gate is the (intentional) control.
    const tools = serverToolsForModel('claude-sonnet-4-6', {
      allowedDomains: ['', '   '],
    });
    expect(webFetchOf(tools)?.allowed_domains).toBeUndefined();
  });

  it('falls back to blocked_domains only when no allow-list is set', () => {
    const tools = serverToolsForModel('claude-sonnet-4-6', {
      blockedDomains: ['evil.example'],
    });
    expect(webFetchOf(tools)?.blocked_domains).toEqual(['evil.example']);
    expect(webFetchOf(tools)?.allowed_domains).toBeUndefined();
  });

  it('never sends both allowed and blocked (allow-list wins — avoids a 400)', () => {
    const tools = serverToolsForModel('claude-sonnet-4-6', {
      allowedDomains: ['good.example'],
      blockedDomains: ['evil.example'],
    });
    expect(webFetchOf(tools)?.allowed_domains).toEqual(['good.example']);
    expect(webFetchOf(tools)?.blocked_domains).toBeUndefined();
  });
});

describe('applyWebFetchAllowlist', () => {
  it('is pure — does not mutate the input definitions', () => {
    const input: ToolDefinition[] = [
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
    ];
    const snapshot = JSON.stringify(input);
    applyWebFetchAllowlist(input, { allowedDomains: ['example.com'] });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns a cloned list when no guard fields are set', () => {
    const input: ToolDefinition[] = [
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
    ];
    const out = applyWebFetchAllowlist(input, {});
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
    expect((out[0] as Record<string, unknown>).allowed_domains).toBeUndefined();
  });

  it('leaves non-web_fetch tools untouched', () => {
    const input: ToolDefinition[] = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    ];
    const out = applyWebFetchAllowlist(input, { allowedDomains: ['example.com'] });
    expect((out[0] as Record<string, unknown>).allowed_domains).toBeUndefined();
  });
});
