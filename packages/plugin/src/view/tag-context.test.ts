import { describe, expect, it } from 'vitest';
import { extractTags } from './tag-context';

describe('extractTags', () => {
  it('returns empty when no tags present', () => {
    expect(extractTags('plain text')).toEqual([]);
  });

  it('extracts a single tag', () => {
    expect(extractTags('checking #skald status')).toEqual(['skald']);
  });

  it('extracts multiple tags', () => {
    expect(extractTags('working on #skald and #obsidian')).toEqual([
      'skald',
      'obsidian',
    ]);
  });

  it('dedupes repeated tags', () => {
    expect(extractTags('#skald and #skald again')).toEqual(['skald']);
  });

  it('supports nested tags with slashes', () => {
    expect(extractTags('working on #projects/skald/2026')).toEqual([
      'projects/skald/2026',
    ]);
  });

  it('supports hyphenated + underscored tags', () => {
    expect(extractTags('#open-loops and #to_do')).toEqual([
      'open-loops',
      'to_do',
    ]);
  });

  it('supports unicode letter tags', () => {
    expect(extractTags('#café')).toEqual(['café']);
  });

  it('caps at 8 tags', () => {
    const text = Array.from({ length: 20 }, (_, i) => `#t${i}`).join(' ');
    expect(extractTags(text).length).toBe(8);
  });

  it('ignores a bare # not followed by tag chars', () => {
    expect(extractTags('# heading')).toEqual([]);
  });
});
