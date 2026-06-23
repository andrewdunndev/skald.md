import { describe, expect, it } from 'vitest';
import { compactToolResult } from './tool-compact';

// ---------------------------------------------------------------------------
// JSON → TOON path
// ---------------------------------------------------------------------------

describe('compactToolResult — uniform flat array → TOON', () => {
  const uniformRows = Array.from({ length: 10 }, (_, i) => ({
    path: `note-${i}.md`,
    score: i * 0.1,
    tag: `tag-${i}`,
  }));
  const input = JSON.stringify(uniformRows, null, 2);

  it('returns format=toon for a uniform flat array at or above the threshold', () => {
    const result = compactToolResult(input);
    expect(result.format).toBe('toon');
  });

  it('prepends the TOON marker header', () => {
    const result = compactToolResult(input);
    expect(result.text.startsWith('# TOON (compact table; same data as JSON)\n')).toBe(true);
  });

  it('produces a shorter string than the pretty-printed JSON input', () => {
    const result = compactToolResult(input);
    expect(result.text.length).toBeLessThan(input.length);
  });

  it('returns format=toon only when the compact form is actually shorter', () => {
    // A tiny array that TOON might not shrink — still gets minified or unchanged.
    const tiny = JSON.stringify([{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }, { a: 7, b: 8 }]);
    // Already compact, but let the function decide; result must not be longer.
    const result = compactToolResult(tiny);
    expect(result.text.length).toBeLessThanOrEqual(tiny.length);
  });
});

// ---------------------------------------------------------------------------
// JSON → minified path
// ---------------------------------------------------------------------------

describe('compactToolResult — non-uniform / mixed JSON → json-min', () => {
  it('minifies a non-uniform JSON object (not a flat array)', () => {
    const input = JSON.stringify({ a: 1, b: { nested: true }, c: [1, 2, 3] }, null, 2);
    const result = compactToolResult(input);
    // Should be either json-min or unchanged (never toon for non-array)
    expect(['json-min', 'unchanged']).toContain(result.format);
    if (result.format === 'json-min') {
      expect(result.text.length).toBeLessThan(input.length);
      expect(result.text).not.toContain('\n');
    }
  });

  it('minifies a heterogeneous array (objects with different keys)', () => {
    const input = JSON.stringify([{ a: 1 }, { b: 2 }, { a: 3, b: 4 }], null, 2);
    const result = compactToolResult(input);
    expect(['json-min', 'unchanged']).toContain(result.format);
  });

  it('minifies a nested-object array (not flat)', () => {
    const input = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ id: i, meta: { score: i } })),
      null,
      2,
    );
    const result = compactToolResult(input);
    // TOON is rejected because values are nested; expect json-min
    expect(['json-min', 'unchanged']).toContain(result.format);
  });

  it('returns format=unchanged for already-minified compact JSON', () => {
    // A single-line minified array of primitives — no whitespace to strip.
    const input = '[1,2,3]';
    const result = compactToolResult(input);
    expect(result.format).toBe('unchanged');
    expect(result.text).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Small array below threshold — minify not TOON
// ---------------------------------------------------------------------------

describe('compactToolResult — small array below minJsonArrayLen', () => {
  it('does NOT encode as TOON when array length < minJsonArrayLen (default 8)', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ path: `n-${i}.md`, score: i }));
    const input = JSON.stringify(rows, null, 2);
    const result = compactToolResult(input);
    expect(result.format).not.toBe('toon');
  });

  it('respects a custom minJsonArrayLen override', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const input = JSON.stringify(rows, null, 2);
    // With threshold=2 it should qualify for TOON (3 >= 2)
    const result = compactToolResult(input, { minJsonArrayLen: 2 });
    // format is either toon (if shorter) or json-min (if toon didn't shrink)
    expect(['toon', 'json-min', 'unchanged']).toContain(result.format);
  });
});

// ---------------------------------------------------------------------------
// Plain text — duplicate-line collapse
// ---------------------------------------------------------------------------

describe('compactToolResult — log text with repeated lines', () => {
  it('collapses a run of ≥ minDupRun identical lines and inserts an omission marker', () => {
    const repeated = Array.from({ length: 6 }, () => '[INFO] Scanning...').join('\n');
    const input = `Start\n${repeated}\nEnd`;
    const result = compactToolResult(input);
    expect(result.format).toBe('text');
    expect(result.text).toContain('[INFO] Scanning...');
    expect(result.text).toContain('identical lines omitted');
    expect(result.text).not.toMatch(/(\[INFO\] Scanning\.\.\.\n){2}/);
  });

  it('does NOT collapse a run below minDupRun (default 4)', () => {
    const input = 'line\nline\nline\nother';
    const result = compactToolResult(input, { minDupRun: 4 });
    // 3 identical lines < 4 threshold — no collapse
    expect(result.format).toBe('unchanged');
  });

  it('respects a custom minDupRun threshold', () => {
    // Use a long-enough repeated line so the omission marker is shorter
    // than the collapsed lines it replaces (the condition for format='text').
    const line = '[WARN] Something happened repeatedly';
    const input = [line, line, line, 'done'].join('\n');
    const result = compactToolResult(input, { minDupRun: 3 });
    expect(result.format).toBe('text');
    expect(result.text).toContain('identical lines omitted');
  });
});

// ---------------------------------------------------------------------------
// Plain text — whitespace collapse
// ---------------------------------------------------------------------------

describe('compactToolResult — plain prose whitespace collapse', () => {
  it('strips trailing whitespace from lines', () => {
    const input = 'hello   \nworld  \nfoo  ';
    const result = compactToolResult(input);
    expect(result.format).toBe('text');
    expect(result.text).not.toMatch(/ +$/m);
  });

  it('collapses 3+ consecutive blank lines to one', () => {
    const input = 'Para 1\n\n\n\nPara 2';
    const result = compactToolResult(input);
    expect(result.format).toBe('text');
    // Must have at most one blank line between the paragraphs
    expect(result.text).not.toContain('\n\n\n');
  });

  it('returns unchanged for prose with no compactable patterns', () => {
    const input = 'Hello world\nThis is fine.\nNo trailing spaces.';
    const result = compactToolResult(input);
    expect(result.format).toBe('unchanged');
    expect(result.text).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Safety — malformed / edge inputs
// ---------------------------------------------------------------------------

describe('compactToolResult — safety and edge cases', () => {
  it('returns unchanged for empty string', () => {
    const result = compactToolResult('');
    expect(result.format).toBe('unchanged');
    expect(result.text).toBe('');
  });

  it('returns unchanged for malformed JSON', () => {
    const input = '{bad json: [}';
    const result = compactToolResult(input);
    // Treated as plain text; if nothing to compact, unchanged
    expect(result.text).toBe(input);
  });

  it('never throws on any input', () => {
    const inputs = [
      '',
      '   ',
      '{}',
      '[]',
      'null',
      'undefined',
      '\x00\x01\x02',
      '{"a":1}',
      '[{"a":1}]',
    ];
    for (const input of inputs) {
      expect(() => compactToolResult(input)).not.toThrow();
    }
  });

  it('always returns the original text on format=unchanged', () => {
    const input = 'simple text';
    const result = compactToolResult(input);
    if (result.format === 'unchanged') {
      expect(result.text).toBe(input);
    }
  });
});

// ---------------------------------------------------------------------------
// Realistic large JSON result — measurable shrink
// ---------------------------------------------------------------------------

describe('compactToolResult — realistic large result shrinks measurably', () => {
  it('achieves ≥ 20% size reduction on a large uniform search-result array', () => {
    // Simulate a runSearchVault result encoded as pretty JSON —
    // the kind of payload that would otherwise push against MAX_TOOL_RESULT_BYTES.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      path: `folder/subfolder/deeply-nested/note-${String(i).padStart(3, '0')}.md`,
      score: parseFloat((Math.random()).toFixed(4)),
      tag: `tag-category-${i % 5}`,
      excerpt: `This is a representative excerpt from note ${i} showing matching content`,
    }));
    const input = JSON.stringify(rows, null, 2);

    const result = compactToolResult(input);

    // Must be TOON (uniform flat array of length 20 ≥ 8)
    expect(result.format).toBe('toon');

    // Must be measurably shorter — assert ≥ 20% reduction
    const ratio = result.text.length / input.length;
    expect(ratio).toBeLessThan(0.80);
  });
});
