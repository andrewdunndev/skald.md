import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@scribian/protocol';
import { notesReadInTurn, readsBeforeToolUse } from './inflight-reads';

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

describe('notesReadInTurn', () => {
  // Input→output vectors covering the collect/exclude/dedupe behaviors.
  // The expected array pins membership, order, and dedup in one assertion,
  // so a regression that double-counts, mis-orders, stops at a write tool,
  // or fails to exclude a search/current_note/write tool fails its row.
  it.each<[string, ContentBlock[], string[]]>([
    ['no tool_use blocks → []', [{ type: 'text', text: 'hello' } as ContentBlock], []],
    [
      'only write tools → []',
      [
        tool('w1', 'write_note', { path: 'A.md', content: '' }),
        tool('w2', 'edit_note', { path: 'B.md' }),
        tool('w3', 'append_to_note', { path: 'C.md', content: '' }),
      ],
      [],
    ],
    [
      'collects read_note paths',
      [tool('r1', 'read_note', { path: 'A.md' }), tool('r2', 'read_note', { path: 'B.md' })],
      ['A.md', 'B.md'],
    ],
    ['collects metadata paths', [tool('m1', 'metadata', { path: 'A.md' })], ['A.md']],
    [
      'collects read_note + metadata together',
      [tool('r1', 'read_note', { path: 'A.md' }), tool('m1', 'metadata', { path: 'B.md' })],
      ['A.md', 'B.md'],
    ],
    [
      'dedupes repeated paths, preserving order',
      [
        tool('r1', 'read_note', { path: 'A.md' }),
        tool('r2', 'read_note', { path: 'B.md' }),
        tool('m1', 'metadata', { path: 'A.md' }),
      ],
      ['A.md', 'B.md'],
    ],
    [
      'excludes search tools (find_related, search_vault)',
      [
        tool('s1', 'search_vault', { query: 'foo' }),
        tool('s2', 'find_related', { query: 'bar' }),
        tool('r1', 'read_note', { path: 'A.md' }),
      ],
      ['A.md'],
    ],
    [
      'excludes current_note (no real path to link)',
      [tool('cn1', 'current_note', {}), tool('r1', 'read_note', { path: 'A.md' })],
      ['A.md'],
    ],
    ['only current_note fired → []', [tool('cn1', 'current_note', {})], []],
    [
      'scans all blocks (not stopped by write tools)',
      [
        tool('r1', 'read_note', { path: 'A.md' }),
        tool('w1', 'write_note', { path: 'X.md', content: '' }),
        tool('r2', 'read_note', { path: 'B.md' }),
      ],
      ['A.md', 'B.md'],
    ],
  ])('%s', (_label, blocks, expected) => {
    expect(notesReadInTurn(blocks)).toEqual(expected);
  });
});
