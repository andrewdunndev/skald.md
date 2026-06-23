import { describe, expect, it } from 'vitest';
import { capResult, MAX_TOOL_RESULT_BYTES } from './read';

// ---------------------------------------------------------------------------
// capResult — UTF-8 byte budget + surrogate-safe truncation (ADR 0010 holes
// C and D). These guard against:
//   (C) splitting a UTF-16 surrogate pair and emitting a lone surrogate, and
//   (D) the cap silently being a CHAR count rather than a real byte count.
// ---------------------------------------------------------------------------

/** True if `s` contains a high or low surrogate code unit not paired up. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate must be followed by a low surrogate
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // skip the valid low surrogate
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low surrogate with no preceding high
    }
  }
  return false;
}

describe('capResult — surrogate-safe truncation (C)', () => {
  it('never emits a lone surrogate when the cut lands inside a surrogate pair', () => {
    // 😀 is U+1F600 (two UTF-16 code units, 4 UTF-8 bytes). cap=10 lands inside
    // the third emoji (bytes 8..12): a naive byte/char slice would split it.
    const emoji = '😀';
    const text = emoji.repeat(100);
    const result = capResult(text, 10, 'narrow');
    const body = result.split('\n\n…truncated')[0];
    expect(hasLoneSurrogate(body)).toBe(false);
    // Two whole emoji fit in 10 bytes (8 bytes); the third is dropped whole.
    expect([...body].every((ch) => ch === emoji)).toBe(true);
    expect(body).toBe(emoji.repeat(2));
  });

  it('cuts on a code-point boundary for a cap that splits a 4-byte char', () => {
    const emoji = '😀'; // 4 UTF-8 bytes
    // cap=2 cannot fit even one emoji → empty body (whole-char drop).
    const tiny = capResult(emoji.repeat(3), 2, 'narrow');
    const body = tiny.split('\n\n…truncated')[0];
    expect(body).toBe('');
    expect(hasLoneSurrogate(body)).toBe(false);
  });
});

describe('capResult — byte vs char measurement (D)', () => {
  it('measures the cap in UTF-8 bytes, not UTF-16 chars', () => {
    // 2000 emoji = 8000 UTF-8 bytes but only 4000 .length chars. A char-based
    // cap of 4096 would pass it through untouched; a byte-based cap truncates.
    const emoji = '😀';
    const text = emoji.repeat(2000);
    expect(text.length).toBeLessThan(MAX_TOOL_RESULT_BYTES); // 4000 < 4096 chars
    const result = capResult(text, MAX_TOOL_RESULT_BYTES, 'narrow');
    expect(result).toContain('…truncated');
  });

  it('reports the true byte total in the truncation footer', () => {
    // 6000 two-byte chars (é, U+00E9) = 12000 bytes = 12KB, only 6000 chars.
    const text = 'é'.repeat(6000);
    const result = capResult(text, MAX_TOOL_RESULT_BYTES, 'narrow');
    expect(result).toContain('of 12KB total');
  });

  it('truncated body never exceeds the byte cap', () => {
    const text = 'é'.repeat(6000); // 12000 bytes
    const result = capResult(text, MAX_TOOL_RESULT_BYTES, 'narrow');
    const body = result.split('\n\n…truncated')[0];
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
  });
});
