import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../../tests/obsidian-mock';
import {
  capResult,
  MAX_TOOL_RESULT_BYTES,
  MAX_NOTE_BYTES,
  runReadNote,
  runListNotes,
  runSearchVault,
} from './read';

// ---------------------------------------------------------------------------
// capResult
// ---------------------------------------------------------------------------

describe('capResult', () => {
  it('passes through content below the cap unchanged', () => {
    const text = 'hello world';
    expect(capResult(text, 100, 'drill down')).toBe(text);
  });

  it('truncates content above the cap and appends footer', () => {
    const text = 'x'.repeat(MAX_TOOL_RESULT_BYTES + 100);
    const result = capResult(text, MAX_TOOL_RESULT_BYTES, 'use limit:N');
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('…truncated');
    expect(result).toContain('use limit:N');
  });

  it('does not truncate content exactly at the cap', () => {
    const text = 'y'.repeat(MAX_TOOL_RESULT_BYTES);
    expect(capResult(text, MAX_TOOL_RESULT_BYTES, 'footer')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Mock App helpers
// ---------------------------------------------------------------------------

function makeFile(path: string): TFile {
  return new TFile(path);
}

function makeApp(files: Record<string, string>): App {
  const tfiles = Object.keys(files).map(makeFile);
  return {
    vault: {
      getAbstractFileByPath: (p: string) =>
        p in files ? new TFile(p) : null,
      read: async (f: TFile) => files[f.path] ?? '',
      cachedRead: async (f: TFile) => files[f.path] ?? '',
      getMarkdownFiles: () => tfiles,
    },
  } as unknown as App;
}

// ---------------------------------------------------------------------------
// runReadNote
// ---------------------------------------------------------------------------

describe('runReadNote', () => {
  it('returns note content', async () => {
    const app = makeApp({ 'test.md': 'hello\nworld' });
    const result = await runReadNote(app, { path: 'test.md' });
    expect(result.content).toContain('hello');
    expect(result.is_error).toBeFalsy();
  });

  it('returns error for missing note', async () => {
    const app = makeApp({});
    const result = await runReadNote(app, { path: 'missing.md' });
    expect(result.is_error).toBe(true);
  });

  it('supports offset_lines and max_lines for range reads', async () => {
    const app = makeApp({ 'n.md': 'line0\nline1\nline2\nline3\nline4' });
    const result = await runReadNote(app, { path: 'n.md', offset_lines: 1, max_lines: 2 });
    expect(result.content).toContain('line1');
    expect(result.content).toContain('line2');
    expect(result.content).not.toContain('line0');
    expect(result.content).not.toContain('line3');
  });

  it('truncates large notes and appends footer', async () => {
    const big = 'a'.repeat(MAX_NOTE_BYTES + 100);
    const app = makeApp({ 'big.md': big });
    const result = await runReadNote(app, { path: 'big.md' });
    expect(result.content).toContain('…truncated');
    expect(result.content).toContain('offset_lines');
  });

  it('does not truncate notes within the cap', async () => {
    const small = 'b'.repeat(MAX_NOTE_BYTES - 1);
    const app = makeApp({ 'small.md': small });
    const result = await runReadNote(app, { path: 'small.md' });
    expect(result.content).not.toContain('…truncated');
  });
});

// ---------------------------------------------------------------------------
// runListNotes — truncation
// ---------------------------------------------------------------------------

describe('runListNotes', () => {
  it('truncates the path list above MAX_TOOL_RESULT_BYTES', () => {
    // Build enough long paths to exceed 4KB.
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      files[`${'some/very/deep/folder/path-'.repeat(2)}note-${i}.md`] = '';
    }
    const app = makeApp(files);
    const result = runListNotes(app, { limit: 200 });
    if (result.content.length > MAX_TOOL_RESULT_BYTES) {
      // Should have been truncated
      expect(result.content).toContain('…truncated');
    }
  });
});

// ---------------------------------------------------------------------------
// runSearchVault — new defaults
// ---------------------------------------------------------------------------

describe('runSearchVault', () => {
  it('defaults to 8 results (was 20)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      files[`note-${i}.md`] = 'needle in note';
    }
    const app = makeApp(files);
    const result = await runSearchVault(app, { query: 'needle' });
    // Count lines — each result is one line
    const lines = result.content.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it('uses short snippets (~60 chars + query, not 240)', async () => {
    const padding = 'x'.repeat(200);
    const app = makeApp({ 'n.md': `${padding}needle${padding}` });
    const result = await runSearchVault(app, { query: 'needle' });
    // The snippet should be well under 200 chars (just 30 each side)
    const snippetLine = result.content;
    // 30 + 6 (needle) + 30 = 66 chars of snippet content max
    expect(snippetLine.length).toBeLessThan(200);
  });

  it('truncates aggregate results above MAX_TOOL_RESULT_BYTES', async () => {
    // Create results whose join would exceed the cap
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      // Each path is long and the content contains the needle
      files[`${'a/'.repeat(20)}note-${i}.md`] = 'foo needle bar';
    }
    const app = makeApp(files);
    const result = await runSearchVault(app, { query: 'needle', limit: 50 });
    if (result.content.length > MAX_TOOL_RESULT_BYTES) {
      expect(result.content).toContain('…truncated');
    }
  });
});
