import { describe, expect, it } from 'vitest';
import type { Message } from '../protocol';
import {
  formatSummary,
  hasAnyAction,
  summarizeVaultActions,
} from './vault-action-summary';

function assistant(blocks: any[]): Message {
  return { role: 'assistant', content: blocks };
}

describe('summarizeVaultActions', () => {
  it('returns zero counts for a pure-text assistant turn', () => {
    const out = summarizeVaultActions(
      assistant([{ type: 'text', text: 'Just an answer.' }]),
    );
    expect(out).toEqual({
      reads: 0,
      searches: 0,
      writes: [],
      rejectedWrites: 0,
    });
    expect(hasAnyAction(out)).toBe(false);
  });

  it('returns zero counts for a string-content message', () => {
    const out = summarizeVaultActions({ role: 'assistant', content: 'plain' });
    expect(hasAnyAction(out)).toBe(false);
  });

  it('counts read_note tool_use as a read', () => {
    const out = summarizeVaultActions(
      assistant([
        { type: 'tool_use', id: 't1', name: 'read_note', input: { path: 'A.md' } },
      ]),
    );
    expect(out.reads).toBe(1);
    expect(hasAnyAction(out)).toBe(true);
  });

  it('counts multiple read-family tools', () => {
    const out = summarizeVaultActions(
      assistant([
        { type: 'tool_use', id: 't1', name: 'read_note', input: { path: 'A.md' } },
        { type: 'tool_use', id: 't2', name: 'list_notes', input: {} },
        { type: 'tool_use', id: 't3', name: 'current_note', input: {} },
      ]),
    );
    expect(out.reads).toBe(3);
  });

  it('counts search_vault as a search', () => {
    const out = summarizeVaultActions(
      assistant([
        { type: 'tool_use', id: 't2', name: 'search_vault', input: { query: 'Y' } },
      ]),
    );
    expect(out.searches).toBe(1);
    expect(out.reads).toBe(0);
  });

  // Write accounting depends on the tool_result outcome paired with the
  // tool_use: a success records the path, a rejection (is_error) counts as
  // rejectedWrites, and a write with no result block (pending/aborted)
  // counts as neither. One row per outcome; the (writes, rejectedWrites)
  // columns pin the full accounting so a mis-bucketed outcome fails its row.
  it.each<[string, any[], string[], number]>([
    [
      'successful write records its path',
      [
        { type: 'tool_use', id: 'w1', name: 'write_note', input: { path: 'Daily/2026-05-15.md', content: 'x' } },
        { type: 'tool_result', tool_use_id: 'w1', content: 'Created Daily/2026-05-15.md (1 chars).' },
      ],
      ['Daily/2026-05-15.md'],
      0,
    ],
    [
      'rejected write counts as rejectedWrites, not writes',
      [
        { type: 'tool_use', id: 'w1', name: 'edit_note', input: { path: 'Notes.md', search: 'x', replace: 'y' } },
        { type: 'tool_result', tool_use_id: 'w1', content: 'User rejected the edit to Notes.md. No changes were made.', is_error: true },
      ],
      [],
      1,
    ],
    [
      'write with no tool_result counts as neither (pending/aborted)',
      [{ type: 'tool_use', id: 'w1', name: 'write_note', input: { path: 'A.md', content: 'x' } }],
      [],
      0,
    ],
  ])('%s', (_label, blocks, expectedWrites, expectedRejected) => {
    const out = summarizeVaultActions(assistant(blocks));
    expect(out.writes).toEqual(expectedWrites);
    expect(out.rejectedWrites).toBe(expectedRejected);
  });

  it('labels memory-tool writes as "memory" instead of a path', () => {
    const out = summarizeVaultActions(
      assistant([
        {
          type: 'tool_use',
          id: 'w1',
          name: 'remember_fact',
          input: { fact: 'something' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'w1',
          content: 'Appended N chars to Skald/Memory.md.',
        },
      ]),
    );
    expect(out.writes).toEqual(['memory']);
  });

  it('handles a mixed turn (read + search + write)', () => {
    const out = summarizeVaultActions(
      assistant([
        { type: 'tool_use', id: 'r1', name: 'search_vault', input: { query: 'X' } },
        { type: 'tool_use', id: 'r2', name: 'read_note', input: { path: 'A.md' } },
        {
          type: 'tool_use',
          id: 'w1',
          name: 'append_to_note',
          input: { path: 'A.md', content: 'note' },
        },
        { type: 'tool_result', tool_use_id: 'w1', content: 'Appended 4 chars to A.md.' },
      ]),
    );
    expect(out.reads).toBe(1);
    expect(out.searches).toBe(1);
    expect(out.writes).toEqual(['A.md']);
  });

  it('ignores server tool_use (web_search) — not vault-action', () => {
    const out = summarizeVaultActions(
      assistant([
        { type: 'server_tool_use', id: 'st1', name: 'web_search', input: {} },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'st1',
          content: [],
        },
      ]),
    );
    expect(hasAnyAction(out)).toBe(false);
  });
});

describe('formatSummary', () => {
  it('produces a terse multi-part summary', () => {
    const s = formatSummary({
      reads: 2,
      searches: 1,
      writes: ['Bailey/Training.md'],
      rejectedWrites: 0,
    });
    expect(s).toBe('📖 read 2 · 🔍 searched 1 · ✏️ wrote Bailey/Training.md');
  });

  it('collapses multiple writes to a count when they differ', () => {
    const s = formatSummary({
      reads: 0,
      searches: 0,
      writes: ['A.md', 'B.md', 'C.md'],
      rejectedWrites: 0,
    });
    expect(s).toBe('✏️ wrote 3 notes');
  });

  it('dedupes when multiple writes hit the same note', () => {
    const s = formatSummary({
      reads: 0,
      searches: 0,
      writes: ['A.md', 'A.md'],
      rejectedWrites: 0,
    });
    // Two writes to the same path display as the single path —
    // the unique-paths check kicks in before the count fallback.
    expect(s).toBe('✏️ wrote A.md');
  });

  it('surfaces rejected writes separately', () => {
    const s = formatSummary({
      reads: 0,
      searches: 0,
      writes: [],
      rejectedWrites: 2,
    });
    expect(s).toBe('↩️ rejected 2');
  });

  it('returns empty string when nothing happened', () => {
    expect(
      formatSummary({ reads: 0, searches: 0, writes: [], rejectedWrites: 0 }),
    ).toBe('');
  });
});
