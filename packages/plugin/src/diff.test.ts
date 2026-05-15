import { describe, expect, it } from 'vitest';
import { lineDiff } from './diff';

describe('lineDiff', () => {
  it('returns all "same" for identical inputs', () => {
    const out = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('classifies a single-line append as one add', () => {
    const out = lineDiff('a\nb', 'a\nb\nc');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'add', text: 'c' },
    ]);
  });

  it('classifies a single-line deletion as one remove', () => {
    const out = lineDiff('a\nb\nc', 'a\nc');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('handles a replacement as remove+add', () => {
    const out = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('treats empty before as all-adds', () => {
    const out = lineDiff('', 'x\ny');
    // empty.split('\n') yields [''], so first 'add' is for the empty
    // line; that matches the LCS reality.
    expect(out.filter((l) => l.type === 'add').map((l) => l.text)).toEqual([
      'x',
      'y',
    ]);
  });

  it('treats empty after as all-removes', () => {
    const out = lineDiff('x\ny', '');
    expect(out.filter((l) => l.type === 'remove').map((l) => l.text)).toEqual(
      ['x', 'y'],
    );
  });

  it('preserves the order of operations across interleaved changes', () => {
    const out = lineDiff('a\nb\nc\nd', 'a\nx\nc\ny');
    expect(out).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
      { type: 'remove', text: 'd' },
      { type: 'add', text: 'y' },
    ]);
  });
});
