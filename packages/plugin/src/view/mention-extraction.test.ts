import { describe, expect, it } from 'vitest';
import {
  extractMentionedPaths,
  unwrittenMentions,
} from './mention-extraction';

describe('extractMentionedPaths', () => {
  it('returns empty when no paths present', () => {
    expect(extractMentionedPaths('just plain prose')).toEqual([]);
  });

  it('extracts a bare .md path', () => {
    expect(
      extractMentionedPaths("I'd add this to Bailey/Training.md."),
    ).toEqual(['Bailey/Training.md']);
  });

  it('extracts multiple distinct .md paths', () => {
    expect(
      extractMentionedPaths(
        'Append to A.md, then read B.md, finally update C.md.',
      ),
    ).toEqual(['A.md', 'B.md', 'C.md']);
  });

  it('dedupes repeated mentions', () => {
    expect(
      extractMentionedPaths('A.md ... A.md again ... A.md a third time.'),
    ).toEqual(['A.md']);
  });

  it('extracts wiki links and appends .md', () => {
    expect(
      extractMentionedPaths('Linking to [[Bailey Training]] would work.'),
    ).toEqual(['Bailey Training.md']);
  });

  it('handles wiki links with display text', () => {
    expect(
      extractMentionedPaths('See [[Projects/X|the X project]] for context.'),
    ).toEqual(['Projects/X.md']);
  });

  it('respects an explicit extension on a wiki link', () => {
    expect(extractMentionedPaths('Image at [[diagram.png]] shows it.')).toEqual([
      'diagram.png',
    ]);
  });

  it('caps at 4 mentions to keep the nudge row terse', () => {
    const text = 'A.md B.md C.md D.md E.md F.md';
    expect(extractMentionedPaths(text)).toHaveLength(4);
  });
});

describe('unwrittenMentions', () => {
  it('returns all mentions when nothing was written', () => {
    expect(unwrittenMentions(['A.md', 'B.md'], [])).toEqual(['A.md', 'B.md']);
  });

  it('drops mentions that were written this turn', () => {
    expect(
      unwrittenMentions(['A.md', 'B.md', 'C.md'], ['B.md']),
    ).toEqual(['A.md', 'C.md']);
  });

  it('returns empty when every mention was already written', () => {
    expect(unwrittenMentions(['A.md'], ['A.md'])).toEqual([]);
  });

  it('preserves mention order', () => {
    expect(
      unwrittenMentions(['Z.md', 'A.md', 'M.md'], []),
    ).toEqual(['Z.md', 'A.md', 'M.md']);
  });
});
