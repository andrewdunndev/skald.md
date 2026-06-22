/**
 * Surrogate-safety for the harness/skills injection cap.
 *
 * MAX_HARNESS_BYTES bounds the injected harness context by UTF-16 code
 * units. A naive slice(0, cap) can cut through a surrogate pair, leaving
 * a trailing lone high surrogate that becomes invalid UTF-8 (a U+FFFD /
 * raw \ud83d escape) once the prompt is JSON-encoded for the provider.
 * capHarnessContext drops a dangling high surrogate so the truncated
 * prompt is always well-formed.
 */
import { describe, expect, it } from 'vitest';
import { capHarnessContext, MAX_HARNESS_BYTES } from './system-prompt';

describe('capHarnessContext: surrogate-safe truncation', () => {
  it('returns input unchanged when under the cap', () => {
    const small = 'hello harness';
    expect(capHarnessContext(small)).toBe(small);
  });

  it('appends the elision marker when over the cap', () => {
    const big = 'a'.repeat(MAX_HARNESS_BYTES + 100);
    const out = capHarnessContext(big);
    expect(out).toContain('[... harness context truncated to cap injected tokens]');
    expect(out.startsWith('a'.repeat(MAX_HARNESS_BYTES))).toBe(true);
  });

  it('never leaves a dangling high surrogate at the cut boundary', () => {
    // Place a 2-code-unit emoji ("😀" = 😀) straddling the cap:
    // MAX_HARNESS_BYTES-1 ASCII chars, then the emoji, then filler. The
    // high surrogate lands at index MAX_HARNESS_BYTES-1 and the low at
    // MAX_HARNESS_BYTES, so a naive slice(0, cap) would keep only the high.
    const prefix = 'x'.repeat(MAX_HARNESS_BYTES - 1);
    const joined = prefix + '\u{1F600}' + 'y'.repeat(50);
    const out = capHarnessContext(joined);

    // The kept body (everything before the marker) must not end in a lone
    // high surrogate.
    const body = out.replace('\n\n[... harness context truncated to cap injected tokens]', '');
    const lastCode = body.charCodeAt(body.length - 1);
    const isLoneHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
    expect(isLoneHighSurrogate).toBe(false);

    // And the whole thing round-trips through UTF-8 without replacement
    // characters (no mojibake introduced by the cut).
    const roundTripped = Buffer.from(body, 'utf8').toString('utf8');
    expect(roundTripped.includes('�')).toBe(false);
  });

  it('keeps a complete surrogate pair when it lands fully inside the cap', () => {
    const joined = 'z'.repeat(MAX_HARNESS_BYTES - 10) + '\u{1F600}' + 'q'.repeat(200);
    const out = capHarnessContext(joined);
    // The emoji should survive intact in the kept body.
    expect(out).toContain('\u{1F600}');
  });
});
