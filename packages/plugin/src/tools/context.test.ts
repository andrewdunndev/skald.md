/**
 * Tests for `safePath` — the single path-validation boundary shared by every
 * vault tool (read/graph/write). An AI drives these tools against a LIVE vault,
 * so this guard is the last line of defense against a model-emitted traversal
 * path. The robustness audit found it had ZERO direct tests and that deleting
 * the `..` guard left the whole suite green (a surviving mutation). These tests
 * close that hole: removing the `..` check (context.ts:77) MUST make the
 * "rejects traversal" cases below fail.
 */
import { describe, expect, it } from 'vitest';
import { safePath } from './context';

describe('safePath — traversal rejection (mutation-critical)', () => {
  // If the `..` guard is removed, every one of these returns a non-null path
  // and these assertions fail. That is the point.
  it.each([
    ['../secret', '../secret'],
    ['a/../../etc/passwd', 'a/../../etc/passwd'],
    ['notes/../../x', 'notes/../../x'],
    ['..', '..'],
    ['../', '../'],
  ])('rejects traversal path %s', (input) => {
    expect(safePath(input)).toBeNull();
  });
});

describe('safePath — non-string / empty input', () => {
  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['object', {}],
  ])('rejects %s', (_label, input) => {
    expect(safePath(input as unknown)).toBeNull();
  });
});

describe('safePath — legitimate vault-relative paths pass through', () => {
  it('returns a simple relative path unchanged', () => {
    expect(safePath('notes/today.md')).toBe('notes/today.md');
  });
  it('returns a deep relative path unchanged', () => {
    expect(safePath('a/b/c/deep-note.md')).toBe('a/b/c/deep-note.md');
  });
  it('collapses duplicate separators', () => {
    expect(safePath('a//b///c.md')).toBe('a/b/c.md');
  });
});

describe('safePath — absolute paths are neutralized to vault-relative (not escapes)', () => {
  // normalizePath strips the leading slash, so an absolute-looking path becomes
  // an in-vault relative path rather than a filesystem escape. Documenting the
  // contract: absolute input is contained, not honored as absolute.
  it('strips the leading slash, keeping the path inside the vault', () => {
    expect(safePath('/etc/passwd')).toBe('etc/passwd');
  });
});
