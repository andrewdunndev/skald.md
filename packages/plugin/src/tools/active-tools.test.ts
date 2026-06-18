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
  it('includes read + write + server tools always (memory-independent)', () => {
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
    // Server tools (web_search, web_fetch) — present by name. Their
    // type pin (e.g. web_search_20260209) tracks the Anthropic
    // version; the toolNames helper prefers .name when both are
    // set so the assertion lands on the stable identifier.
    for (const t of SERVER_TOOLS) {
      expect(names).toContain(t.name as string);
    }
  });

  it('EXCLUDES memory tools when memoryEnabled is false', () => {
    const out = buildActiveTools({
      memoryEnabled: false,
      memoryPath: 'Scribian/Memory.md',
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
      memoryPath: 'Scribian/Memory.md',
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
