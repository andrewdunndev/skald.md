/**
 * serverToolsForModel unit tests.
 *
 * Ensures the correct Anthropic server-tool version pins are selected
 * per model id. Haiku models must receive the older 20250305/20250910
 * pins; all other models must receive the current 20260209 pins.
 */
import { describe, expect, it } from 'vitest';
import { serverToolsForModel } from './server';

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
});
