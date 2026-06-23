/**
 * buildActiveTools tests. The gate matters at runtime — Claude
 * only sees tools whose preconditions are satisfied, so it can't
 * call remember_fact when memory is disabled and waste a turn on
 * a configuration error.
 */
import { describe, expect, it } from 'vitest';
import {
  buildActiveTools,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  MEMORY_TOOLS,
  SERVER_TOOLS,
  serverToolsForModel,
} from './index';

function toolNames(defs: ReadonlyArray<{ name?: string; type?: string }>): string[] {
  return defs.map((d) => d.name ?? d.type ?? '?');
}

describe('buildActiveTools', () => {
  it('includes read + write tools always (memory-independent)', () => {
    const out = buildActiveTools({ memoryEnabled: false, memoryPath: '' });
    const names = toolNames(out);
    // Every read tool present
    for (const t of READ_ONLY_TOOLS) {
      expect(names).toContain(t.name as string);
    }
    // Every write tool present
    for (const t of WRITE_TOOLS) {
      expect(names).toContain(t.name as string);
    }
  });

  it('OMITS web tools by default (webToolsEnabled defaults to off)', () => {
    // SECURITY: web_fetch is a prompt-injection exfiltration channel, so
    // the default catalog must NOT include it. This test fails if the
    // default flips back to always-on.
    const out = buildActiveTools({ memoryEnabled: false, memoryPath: '' });
    const names = toolNames(out);
    for (const t of SERVER_TOOLS) {
      expect(
        names,
        `${t.name} must NOT appear when webToolsEnabled is unset`,
      ).not.toContain(t.name as string);
    }
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('web_search');
  });

  it('OMITS web tools when webToolsEnabled is explicitly false', () => {
    const out = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      webToolsEnabled: false,
    });
    const names = toolNames(out);
    expect(names).not.toContain('web_fetch');
    expect(names).not.toContain('web_search');
  });

  it('INCLUDES web tools when webToolsEnabled is true', () => {
    const out = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      webToolsEnabled: true,
    });
    const names = toolNames(out);
    for (const t of SERVER_TOOLS) {
      expect(names).toContain(t.name as string);
    }
  });

  it('applies allowed_domains to web_fetch when a list is configured', () => {
    const out = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      webToolsEnabled: true,
      webFetchAllowedDomains: ['en.wikipedia.org', 'docs.anthropic.com'],
    });
    const webFetch = out.find(
      (t) => (t as Record<string, unknown>).name === 'web_fetch',
    ) as Record<string, unknown> | undefined;
    expect(webFetch).toBeDefined();
    expect(webFetch?.allowed_domains).toEqual([
      'en.wikipedia.org',
      'docs.anthropic.com',
    ]);
    // web_search must NOT carry the allow-list (it's a fetch-only guard).
    const webSearch = out.find(
      (t) => (t as Record<string, unknown>).name === 'web_search',
    ) as Record<string, unknown> | undefined;
    expect(webSearch?.allowed_domains).toBeUndefined();
  });

  it('does NOT set allowed_domains when the list is empty', () => {
    const out = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      webToolsEnabled: true,
      webFetchAllowedDomains: [],
    });
    const webFetch = out.find(
      (t) => (t as Record<string, unknown>).name === 'web_fetch',
    ) as Record<string, unknown> | undefined;
    expect(webFetch).toBeDefined();
    // Empty list → no restriction key (an empty allowed_domains would be
    // read by Anthropic as "allow nothing" and break all fetches).
    expect(webFetch?.allowed_domains).toBeUndefined();
  });

  it('EXCLUDES memory tools when memoryEnabled is false', () => {
    const out = buildActiveTools({
      memoryEnabled: false,
      memoryPath: 'Skald/Memory.md',
    });
    const names = toolNames(out);
    for (const t of MEMORY_TOOLS) {
      expect(
        names,
        `${t.name} should not appear when memoryEnabled is false`,
      ).not.toContain(t.name as string);
    }
  });

  it('EXCLUDES memory tools when memoryPath is empty (even if enabled)', () => {
    const out = buildActiveTools({ memoryEnabled: true, memoryPath: '' });
    const names = toolNames(out);
    for (const t of MEMORY_TOOLS) {
      expect(names).not.toContain(t.name as string);
    }
  });

  it('EXCLUDES memory tools when memoryPath is whitespace-only', () => {
    const out = buildActiveTools({ memoryEnabled: true, memoryPath: '   ' });
    const names = toolNames(out);
    for (const t of MEMORY_TOOLS) {
      expect(names).not.toContain(t.name as string);
    }
  });

  it('INCLUDES memory tools when both enabled + path are set', () => {
    const out = buildActiveTools({
      memoryEnabled: true,
      memoryPath: 'Skald/Memory.md',
    });
    const names = toolNames(out);
    expect(names).toContain('remember_fact');
    expect(names).toContain('update_memory');
    expect(names).toContain('forget_fact');
  });

  it('passes model through to serverToolsForModel — haiku gets old pins', () => {
    const tools = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      model: 'claude-haiku-4-5',
      webToolsEnabled: true,
    });
    const haikuExpected = serverToolsForModel('claude-haiku-4-5');
    // Every haiku server tool should appear in the built list.
    for (const expected of haikuExpected) {
      const match = tools.find(
        (t) =>
          (t as Record<string, unknown>).type ===
          (expected as Record<string, unknown>).type,
      );
      expect(match, `expected type ${(expected as Record<string, unknown>).type as string}`).toBeDefined();
    }
  });

  it('passes model through to serverToolsForModel — sonnet gets new pins', () => {
    const tools = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      model: 'claude-sonnet-4-6',
      webToolsEnabled: true,
    });
    const sonnetExpected = serverToolsForModel('claude-sonnet-4-6');
    for (const expected of sonnetExpected) {
      const match = tools.find(
        (t) =>
          (t as Record<string, unknown>).type ===
          (expected as Record<string, unknown>).type,
      );
      expect(match, `expected type ${(expected as Record<string, unknown>).type as string}`).toBeDefined();
    }
  });
});
