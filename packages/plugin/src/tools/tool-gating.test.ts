/**
 * Tool gating by connection mode. Verifies that:
 *   - buildActiveTools does NOT filter out tools in direct mode —
 *     server tools (web_search / web_fetch) are provider-side and work
 *     regardless of how the plugin connects.
 *   - executeTool returns a clear "worker required" error when
 *     find_related is called in direct mode (defense-in-depth; the tool
 *     should not appear in the catalog but if it somehow does, the
 *     executor catches it).
 */
import { describe, expect, it, vi } from 'vitest';
import { buildActiveTools, executeTool, SERVER_TOOLS } from './index';

function toolNames(defs: ReadonlyArray<{ name?: string; type?: string }>): string[] {
  return defs.map((d) => d.name ?? d.type ?? '?');
}

describe('buildActiveTools: direct mode', () => {
  it('includes server tools in direct mode (they run on the provider side)', () => {
    const tools = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      connectionMode: 'direct',
    });
    const names = toolNames(tools);
    for (const t of SERVER_TOOLS) {
      expect(names).toContain(t.name as string);
    }
  });

  it('includes read + write tools in direct mode', () => {
    const tools = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      connectionMode: 'direct',
    });
    expect(toolNames(tools)).toContain('read_note');
    expect(toolNames(tools)).toContain('write_note');
  });

  it('includes memory tools in direct mode when memory is enabled', () => {
    const tools = buildActiveTools({
      memoryEnabled: true,
      memoryPath: 'Scribian/Memory.md',
      connectionMode: 'direct',
    });
    expect(toolNames(tools)).toContain('remember_fact');
  });
});

describe('buildActiveTools: worker mode', () => {
  it('includes server tools in worker mode', () => {
    const tools = buildActiveTools({
      memoryEnabled: false,
      memoryPath: '',
      connectionMode: 'worker',
    });
    expect(toolNames(tools)).toContain('web_search');
  });
});

describe('executeTool: find_related in direct mode', () => {
  it('returns a worker-required error message', async () => {
    const result = await executeTool('find_related', { query: 'test' }, 'tid', {
      app: {} as any,
      approve: vi.fn(),
      connectionMode: 'direct',
    });
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/direct mode/i);
    expect(result.content).toMatch(/worker/i);
  });
});

describe('executeTool: find_related in worker mode without memoryClient', () => {
  it('returns a configuration error (not configured, not a direct-mode gate)', async () => {
    const result = await executeTool('find_related', { query: 'test' }, 'tid', {
      app: {} as any,
      approve: vi.fn(),
      connectionMode: 'worker',
      // memoryClient absent
    });
    expect(result.is_error).toBe(true);
    // Should mention configuration, not direct mode
    expect(result.content).not.toMatch(/direct mode/i);
    expect(result.content).toMatch(/configured/i);
  });
});
