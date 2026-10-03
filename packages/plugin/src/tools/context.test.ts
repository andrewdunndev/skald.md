/**
 * Tests for `safePath` — the single path-validation boundary shared by every
 * vault tool (read/graph/write). An AI drives these tools against a LIVE vault,
 * so this guard is the last line of defense against a model-emitted traversal
 * path. The robustness audit found it had ZERO direct tests and that deleting
 * the `..` guard left the whole suite green (a surviving mutation). These tests
 * close that hole: removing the dot-segment check MUST make the
 * "rejects traversal" cases below fail.
 */
import { describe, expect, it } from 'vitest';
import { safeNotePath, safePath } from './context';

describe('safePath — traversal rejection (mutation-critical)', () => {
  // If the dot-segment guard is removed, every one of these returns a non-null path
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

describe('safePath — hidden segments are rejected', () => {
  it.each([
    '.obsidian/plugins/x/main.js',
    '.obsidian/community-plugins.json',
    'notes/.trash/a.md',
    '.hidden.md',
    'a/./b.md',
  ])('rejects %s', (input) => {
    expect(safePath(input)).toBeNull();
  });

  it('allows dots inside a segment name', () => {
    expect(safePath('notes/v1.2..final.md')).toBe('notes/v1.2..final.md');
  });
});

describe('safeNotePath — writes are .md only', () => {
  it('accepts a markdown note', () => {
    expect(safeNotePath('Projects/plan.md')).toBe('Projects/plan.md');
  });
  it.each(['main.js', 'data.json', 'board.canvas', 'notes', 'a.md.js', '.obsidian/x.md'])(
    'rejects %s',
    (input) => {
      expect(safeNotePath(input)).toBeNull();
    },
  );
});
