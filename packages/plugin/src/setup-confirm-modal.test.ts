import { describe, expect, it } from 'vitest';
import { maskToken } from './setup-confirm-modal';

describe('maskToken', () => {
  it('shows first 4 + last 4 with ellipsis for a normal-length token', () => {
    expect(maskToken('abcdef1234567890abcdef')).toBe('abcd…cdef');
  });

  it('masks an entire short token with bullets', () => {
    expect(maskToken('short')).toBe('••••••••');
  });

  it('masks an empty string with the floor of 8 bullets', () => {
    expect(maskToken('')).toBe('••••••••');
  });

  it('trims whitespace before measuring length', () => {
    // 'aaa' is 3 chars after trim — under 12 → fully masked
    expect(maskToken('  aaa  ')).toBe('••••••••');
  });

  it('handles exactly 12 chars (the boundary)', () => {
    expect(maskToken('abcdefghijkl')).toBe('abcd…ijkl');
  });

  it('never includes the middle of the token in the masked form', () => {
    const out = maskToken('abcdef-SECRETMIDDLE-1234');
    expect(out).not.toContain('SECRETMIDDLE');
  });
});
