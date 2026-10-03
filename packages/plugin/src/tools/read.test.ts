import { describe, expect, it, vi } from 'vitest';
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
import * as rerank from './rerank';
import { executeTool } from './index';

function setOmnisearch(app: unknown, api: unknown): void {
  (app as { plugins?: unknown }).plugins = api ? { plugins: { omnisearch: { api } } } : undefined;
}

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
    // 200 unique deep paths (~12KB) exceed the 4KB cap even after compaction
    // (unique paths don't compress), so truncation must fire.
    expect(result.content).toContain('…truncated');
  });
});

// ---------------------------------------------------------------------------
// runSearchVault — new defaults (substring scan path)
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
    for (let i = 0; i < 100; i++) {
      // Long unique paths so the aggregate clearly exceeds the 4KB cap.
      files[`${'deep/folder/'.repeat(8)}note-${i}.md`] = 'foo needle bar';
    }
    const app = makeApp(files);
    const result = await runSearchVault(app, { query: 'needle', limit: 100 });
    expect(result.content).toContain('…truncated');
  });
});

// ---------------------------------------------------------------------------
// runSearchVault — Omnisearch integration
// ---------------------------------------------------------------------------

describe('runSearchVault — Omnisearch', () => {
  /** Build a fake Omnisearch result. */
  function makeHit(path: string, excerpt: string, score = 1.0) {
    return { score, path, basename: path.split('/').pop() ?? path, foundWords: [], excerpt, matches: [] };
  }

  it('uses Omnisearch when present and prepends ranked header', async () => {
    const files = { 'a.md': 'hello', 'b.md': 'world' };
    const app = makeApp(files);

    const hits = [makeHit('ranked/first.md', 'first excerpt'), makeHit('ranked/second.md', 'second excerpt')];
    setOmnisearch(app, { search: async () => hits });

    try {
      const result = await runSearchVault(app, { query: 'anything' });
      expect(result.is_error).toBeFalsy();
      expect(result.content).toContain('(via omnisearch: ranked)');
      expect(result.content).toContain('ranked/first.md');
      expect(result.content).toContain('first excerpt');
      expect(result.content).toContain('ranked/second.md');
    } finally {
      setOmnisearch(app, undefined);
    }
  });

  it('respects limit when slicing Omnisearch results', async () => {
    const app = makeApp({});
    const hits = Array.from({ length: 20 }, (_, i) => makeHit(`note-${i}.md`, `excerpt ${i}`));
    setOmnisearch(app, { search: async () => hits });

    try {
      const result = await runSearchVault(app, { query: 'x', limit: 3 });
      // Header + 3 result lines = 4 lines total
      const lines = result.content.split('\n').filter((l) => l.trim());
      expect(lines.length).toBe(4); // 1 header + 3 results
      expect(result.content).toContain('note-0.md');
      expect(result.content).not.toContain('note-3.md');
    } finally {
      setOmnisearch(app, undefined);
    }
  });

  it('falls back to substring scan when Omnisearch throws', async () => {
    const app = makeApp({ 'fallback.md': 'needle content here' });
    setOmnisearch(app, {
      search: async () => { throw new Error('index not ready'); },
    });

    try {
      const result = await runSearchVault(app, { query: 'needle' });
      expect(result.is_error).toBeFalsy();
      expect(result.content).not.toContain('(via omnisearch: ranked)');
      expect(result.content).toContain('fallback.md');
    } finally {
      setOmnisearch(app, undefined);
    }
  });

  it('falls back to substring scan when Omnisearch is absent', async () => {
    const app = makeApp({ 'scan.md': 'find this needle here' });
    setOmnisearch(app, undefined);
    try {
      const result = await runSearchVault(app, { query: 'needle' });
      expect(result.is_error).toBeFalsy();
      expect(result.content).not.toContain('(via omnisearch: ranked)');
      expect(result.content).toContain('scan.md');
    } finally {
      setOmnisearch(app, undefined);
    }
  });

  it('falls back to scan when Omnisearch returns zero hits', async () => {
    const app = makeApp({ 'scan.md': 'needle present here' });
    setOmnisearch(app, { search: async () => [] });

    try {
      const result = await runSearchVault(app, { query: 'needle' });
      expect(result.is_error).toBeFalsy();
      // Header must NOT appear — fell through to scan
      expect(result.content).not.toContain('(via omnisearch: ranked)');
      expect(result.content).toContain('scan.md');
    } finally {
      setOmnisearch(app, undefined);
    }
  });

  it('caps Omnisearch output with truncation footer above 4KB', async () => {
    const app = makeApp({});
    const hits = Array.from({ length: 50 }, (_, i) =>
      makeHit(`${'long/path/'.repeat(5)}note-${i}.md`, 'x'.repeat(200)),
    );
    setOmnisearch(app, { search: async () => hits });

    try {
      const result = await runSearchVault(app, { query: 'x', limit: 50 });
      expect(result.content).toContain('…truncated');
    } finally {
      setOmnisearch(app, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// runSearchVault — rerank integration
// ---------------------------------------------------------------------------

describe('runSearchVault — rerank integration', () => {
  it('calls rerankCandidates and prepends "(reranked by utility model)" when >5 substring results', async () => {
    // Build 8 files all containing the needle
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      files[`note-${i}.md`] = 'needle in here';
    }
    const app = makeApp(files);

    // Stub rerankCandidates to return a known reordering
    const spy = vi.spyOn(rerank, 'rerankCandidates').mockResolvedValue([
      'note-7.md: …needle in here…',
      'note-6.md: …needle in here…',
      'note-5.md: …needle in here…',
      'note-4.md: …needle in here…',
      'note-3.md: …needle in here…',
    ]);

    try {
      const result = await runSearchVault(app, { query: 'needle', limit: 8 }, 'sk-ant-test', 'anthropic');
      expect(spy).toHaveBeenCalledWith('needle', expect.any(Array), 'anthropic', 'sk-ant-test');
      expect(result.content).toContain('(reranked by utility model)');
      expect(result.content).toContain('note-7.md');
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT call rerank when results <= 5', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      files[`note-${i}.md`] = 'needle content';
    }
    const app = makeApp(files);

    const spy = vi.spyOn(rerank, 'rerankCandidates');

    const result = await runSearchVault(app, { query: 'needle' }, 'sk-ant-test', 'anthropic');
    expect(spy).not.toHaveBeenCalled();
    expect(result.content).not.toContain('(reranked by utility model)');

    spy.mockRestore();
  });

  it('does NOT call rerank when the active provider is openrouter', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      files[`note-${i}.md`] = 'needle in here';
    }
    const app = makeApp(files);

    const spy = vi.spyOn(rerank, 'rerankCandidates');

    // Even with >5 results and a key present, an OpenRouter user must
    // not silently hit Anthropic for the rerank.
    const result = await runSearchVault(
      app,
      { query: 'needle', limit: 8 },
      'sk-ant-test',
      'openrouter',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.content).not.toContain('(reranked by utility model)');

    spy.mockRestore();
  });

  it('executeTool hands the context key and provider to the search rerank', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`note-${i}.md`] = 'needle in here';
    const spy = vi.spyOn(rerank, 'rerankCandidates').mockResolvedValue(['note-1.md: …needle…']);
    try {
      await executeTool('search_vault', { query: 'needle', limit: 8 }, 't1', {
        app: makeApp(files),
        approve: () => Promise.resolve(false),
        anthropicApiKey: 'sk-ant-ctx',
        provider: 'anthropic',
      });
      expect(spy).toHaveBeenCalledWith('needle', expect.any(Array), 'anthropic', 'sk-ant-ctx');
    } finally {
      spy.mockRestore();
    }
  });
});
