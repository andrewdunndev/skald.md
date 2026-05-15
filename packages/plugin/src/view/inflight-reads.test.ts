import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@scribian/protocol';
import { readsBeforeToolUse } from './inflight-reads';

function tool(id: string, name: string, input: unknown): ContentBlock {
  return { type: 'tool_use', id, name, input } as ContentBlock;
}

describe('readsBeforeToolUse', () => {
  it('returns empty when there are no prior reads', () => {
    const blocks = [
      { type: 'text', text: 'thinking out loud' } as ContentBlock,
      tool('w1', 'write_note', { path: 'A.md', content: 'x' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual([]);
  });

  it('captures read_note paths', () => {
    const blocks = [
      tool('r1', 'read_note', { path: 'A.md' }),
      tool('r2', 'read_note', { path: 'B.md' }),
      tool('w1', 'write_note', { path: 'C.md', content: '' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual(['A.md', 'B.md']);
  });

  it('captures metadata paths', () => {
    const blocks = [
      tool('m1', 'metadata', { path: 'A.md' }),
      tool('w1', 'edit_note', { path: 'A.md' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual(['A.md']);
  });

  it('renders current_note as a fixed placeholder', () => {
    const blocks = [
      tool('cn1', 'current_note', {}),
      tool('w1', 'write_note', { path: 'A.md', content: '' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual(['(active note)']);
  });

  it('renders find_related as a truncated search: prefix', () => {
    const blocks = [
      tool('fr1', 'find_related', {
        query: 'notes about photography workflows in my vault that I have written',
      }),
      tool('w1', 'append_to_note', { path: 'A.md', content: '' }),
    ];
    const out = readsBeforeToolUse(blocks, 'w1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^search: "/);
    expect(out[0].length).toBeLessThanOrEqual('search: "'.length + 40 + 1);
  });

  it('stops at the current tool_use — later reads are excluded', () => {
    const blocks = [
      tool('r1', 'read_note', { path: 'Before.md' }),
      tool('w1', 'write_note', { path: 'X.md', content: '' }),
      tool('r2', 'read_note', { path: 'After.md' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual(['Before.md']);
  });

  it('dedupes when the same source is read twice', () => {
    const blocks = [
      tool('r1', 'read_note', { path: 'A.md' }),
      tool('r2', 'read_note', { path: 'A.md' }),
      tool('w1', 'write_note', { path: 'X.md', content: '' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual(['A.md']);
  });

  it('ignores write tool_use blocks (they are not reads)', () => {
    const blocks = [
      tool('w1', 'write_note', { path: 'A.md', content: '' }),
      tool('w2', 'edit_note', { path: 'A.md' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w2')).toEqual([]);
  });

  it('ignores non-vault tool_use (e.g. server tools)', () => {
    const blocks = [
      tool('s1', 'web_search', { query: 'x' }),
      tool('w1', 'write_note', { path: 'A.md', content: '' }),
    ];
    expect(readsBeforeToolUse(blocks, 'w1')).toEqual([]);
  });
});
