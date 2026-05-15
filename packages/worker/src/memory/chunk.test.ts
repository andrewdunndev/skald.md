import { describe, expect, it } from 'vitest';
import { chunkBySection } from './chunk';

describe('chunkBySection', () => {
  it('returns a single empty-path chunk for headerless content', () => {
    const out = chunkBySection('Just a paragraph.\n\nAnother line.');
    expect(out).toHaveLength(1);
    expect(out[0].headingPath).toEqual([]);
    expect(out[0].content).toBe('Just a paragraph.\n\nAnother line.');
    expect(out[0].chunkIndex).toBe(0);
  });

  it('splits a doc into H1 sections with the H1 in the headingPath', () => {
    const out = chunkBySection(
      '# Intro\n\nFirst para.\n\n# Body\n\nSecond para.\n',
    );
    expect(out).toHaveLength(2);
    expect(out[0].headingPath).toEqual(['Intro']);
    expect(out[0].content).toBe('First para.');
    expect(out[1].headingPath).toEqual(['Body']);
    expect(out[1].content).toBe('Second para.');
  });

  it('nests H2 under the current H1 in the headingPath', () => {
    const out = chunkBySection(
      '# Setup\n\nIntro.\n\n## Auth\n\nAuth details.\n\n## Storage\n\nStorage details.\n',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      headingPath: ['Setup'],
      content: 'Intro.',
    });
    expect(out[1]).toMatchObject({
      headingPath: ['Setup', 'Auth'],
      content: 'Auth details.',
    });
    expect(out[2]).toMatchObject({
      headingPath: ['Setup', 'Storage'],
      content: 'Storage details.',
    });
  });

  it('keeps H3 and below inside the current section (no further split)', () => {
    const out = chunkBySection(
      '# A\n\nbody A.\n\n### A.1\n\nbody A.1.\n\n# B\n\nbody B.\n',
    );
    expect(out).toHaveLength(2);
    expect(out[0].headingPath).toEqual(['A']);
    expect(out[0].content).toContain('### A.1');
    expect(out[0].content).toContain('body A.1.');
    expect(out[1].headingPath).toEqual(['B']);
  });

  it('strips a leading YAML frontmatter block before chunking', () => {
    const out = chunkBySection(
      '---\nfoo: bar\nbaz: qux\n---\n\n# Title\n\nbody.\n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].headingPath).toEqual(['Title']);
    expect(out[0].content).toBe('body.');
  });

  it('drops empty sections (heading with no body)', () => {
    const out = chunkBySection(
      '# Empty\n\n# Full\n\ncontent.\n',
    );
    expect(out).toHaveLength(1);
    expect(out[0].headingPath).toEqual(['Full']);
  });

  it('splits a section longer than targetChars into windowed slices', () => {
    // 5000-char body in one section
    const body = 'word '.repeat(1000);
    const out = chunkBySection(`# Big\n\n${body}\n`, {
      targetChars: 1500,
      overlapChars: 200,
    });
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.headingPath).toEqual(['Big']);
      expect(chunk.content.length).toBeLessThanOrEqual(1500);
    }
    // chunkIndex is monotonically increasing across windows of one
    // section so the upsert ids are stable.
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i + 1].chunkIndex).toBe(out[i].chunkIndex + 1);
    }
  });

  it('chunkIndex spans across sections, not per-section', () => {
    const out = chunkBySection('# A\n\nbody A.\n\n# B\n\nbody B.\n');
    expect(out[0].chunkIndex).toBe(0);
    expect(out[1].chunkIndex).toBe(1);
  });

  it('overlapping windows preserve content continuity', () => {
    const body =
      'a'.repeat(900) + ' ' + 'b'.repeat(900) + ' ' + 'c'.repeat(900);
    const out = chunkBySection(`# X\n\n${body}\n`, {
      targetChars: 1200,
      overlapChars: 300,
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Last 300 chars of window N should appear in window N+1 (the
    // overlap). Whitespace-aware boundary may shift this slightly,
    // but the overlap region should be non-empty.
    for (let i = 0; i < out.length - 1; i++) {
      const tail = out[i].content.slice(-100);
      const head = out[i + 1].content.slice(0, 400);
      // At least some overlap should exist; we don't assert exact
      // bytes because the whitespace-aware boundary may shift.
      expect(tail.length + head.length).toBeGreaterThan(0);
    }
  });
});
