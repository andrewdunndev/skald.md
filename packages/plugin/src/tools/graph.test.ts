import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../../tests/obsidian-mock';
import {
  runFindByTag,
  runFindByLink,
  runRecentNotes,
  runOutline,
  runSearchInFolder,
} from './graph';

// ---------------------------------------------------------------------------
// Minimal metadataCache shape
// ---------------------------------------------------------------------------

interface FakeCache {
  tags?: Array<{ tag: string }>;
  frontmatter?: { tags?: string[] };
  headings?: Array<{ level: number; heading: string }>;
}

interface FakeApp {
  vault: {
    getMarkdownFiles: () => TFile[];
    getAbstractFileByPath: (p: string) => TFile | null;
    cachedRead: (f: TFile) => Promise<string>;
  };
  metadataCache: {
    getFileCache: (f: TFile) => FakeCache | null;
    resolvedLinks: Record<string, Record<string, number>>;
    getBacklinksForFile?: (f: TFile) => { data?: Record<string, unknown> };
  };
}

function makeFile(path: string, mtime = 0): TFile {
  const f = new TFile(path);
  // Patch stat.mtime on the mock — TFile from obsidian-mock has a stat object
  (f as unknown as { stat: { mtime: number } }).stat = { mtime };
  return f;
}

function makeApp(opts: {
  files: TFile[];
  caches?: Record<string, FakeCache>;
  resolvedLinks?: Record<string, Record<string, number>>;
  backlinks?: Record<string, Record<string, unknown>>;
  contents?: Record<string, string>;
}): App {
  const caches = opts.caches ?? {};
  const resolvedLinks = opts.resolvedLinks ?? {};
  const backlinks = opts.backlinks ?? {};
  const contents = opts.contents ?? {};

  const stub: FakeApp = {
    vault: {
      getMarkdownFiles: () => opts.files,
      getAbstractFileByPath: (p) => opts.files.find((f) => f.path === p) ?? null,
      cachedRead: async (f) => contents[f.path] ?? '',
    },
    metadataCache: {
      getFileCache: (f) => caches[f.path] ?? null,
      resolvedLinks,
      getBacklinksForFile: (f): { data?: Record<string, unknown> } =>
        backlinks[f.path] ? { data: backlinks[f.path] } : {},
    },
  };
  return stub as unknown as App;
}

// ---------------------------------------------------------------------------
// find_by_tag
// ---------------------------------------------------------------------------

describe('runFindByTag', () => {
  it('returns notes that have ALL given tags (intersection)', () => {
    const a = makeFile('a.md', 3);
    const b = makeFile('b.md', 2);
    const c = makeFile('c.md', 1);
    const app = makeApp({
      files: [a, b, c],
      caches: {
        'a.md': { tags: [{ tag: '#project' }, { tag: '#active' }] },
        'b.md': { tags: [{ tag: '#project' }] },
        'c.md': { tags: [{ tag: '#active' }] },
      },
    });

    const result = runFindByTag(app, { tags: ['project', 'active'] });
    expect(result.is_error).toBeFalsy();
    expect(result.content).toContain('a.md');
    expect(result.content).not.toContain('b.md');
    expect(result.content).not.toContain('c.md');
  });

  it('includes frontmatter tags in the intersection check', () => {
    const a = makeFile('a.md');
    const app = makeApp({
      files: [a],
      caches: {
        'a.md': {
          tags: [{ tag: '#project' }],
          frontmatter: { tags: ['active'] },
        },
      },
    });
    const result = runFindByTag(app, { tags: ['project', 'active'] });
    expect(result.content).toContain('a.md');
  });

  it('returns error for empty tags array', () => {
    const app = makeApp({ files: [] });
    const result = runFindByTag(app, { tags: [] });
    expect(result.is_error).toBe(true);
  });

  it('respects the limit param', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`note-${i}.md`, i),
    );
    const caches: Record<string, FakeCache> = {};
    for (const f of files) caches[f.path] = { tags: [{ tag: '#foo' }] };
    const app = makeApp({ files, caches });
    const result = runFindByTag(app, { tags: ['foo'], limit: 3 });
    // Exactly 3 path lines (plus optional "… and N more" line)
    const pathLines = result.content.split('\n').filter((l) => l.endsWith('.md'));
    expect(pathLines.length).toBe(3);
  });

  it('returns a no-match message when nothing qualifies', () => {
    const app = makeApp({
      files: [makeFile('a.md')],
      caches: { 'a.md': { tags: [] } },
    });
    const result = runFindByTag(app, { tags: ['nonexistent'] });
    expect(result.content).toContain('no notes');
  });
});

// ---------------------------------------------------------------------------
// find_by_link
// ---------------------------------------------------------------------------

describe('runFindByLink', () => {
  it('returns outgoing links for direction=out', () => {
    const a = makeFile('a.md');
    const app = makeApp({
      files: [a],
      resolvedLinks: { 'a.md': { 'b.md': 1, 'c.md': 1 } },
    });
    const result = runFindByLink(app, { path: 'a.md', direction: 'out' });
    expect(result.content).toContain('b.md');
    expect(result.content).toContain('c.md');
  });

  it('returns backlinks for direction=in', () => {
    const a = makeFile('a.md');
    const app = makeApp({
      files: [a],
      backlinks: { 'a.md': { 'x.md': {}, 'y.md': {} } },
    });
    const result = runFindByLink(app, { path: 'a.md', direction: 'in' });
    expect(result.content).toContain('x.md');
    expect(result.content).toContain('y.md');
  });

  it('returns union for direction=both (default)', () => {
    const a = makeFile('a.md');
    const app = makeApp({
      files: [a],
      resolvedLinks: { 'a.md': { 'out.md': 1 } },
      backlinks: { 'a.md': { 'in.md': {} } },
    });
    const result = runFindByLink(app, { path: 'a.md' });
    expect(result.content).toContain('out.md');
    expect(result.content).toContain('in.md');
  });

  it('returns error for missing note', () => {
    const app = makeApp({ files: [] });
    const result = runFindByLink(app, { path: 'nonexistent.md' });
    expect(result.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recent_notes
// ---------------------------------------------------------------------------

describe('runRecentNotes', () => {
  it('returns files sorted by mtime descending', () => {
    const old = makeFile('old.md', 1);
    const newest = makeFile('newest.md', 100);
    const mid = makeFile('mid.md', 50);
    const app = makeApp({ files: [old, newest, mid] });
    const result = runRecentNotes(app, {});
    const lines = result.content.split('\n');
    expect(lines[0]).toBe('newest.md');
    expect(lines[1]).toBe('mid.md');
    expect(lines[2]).toBe('old.md');
  });

  it('scopes to a folder when provided', () => {
    const a = makeFile('work/a.md', 10);
    const b = makeFile('personal/b.md', 20);
    const app = makeApp({ files: [a, b] });
    const result = runRecentNotes(app, { folder: 'work' });
    expect(result.content).toContain('work/a.md');
    expect(result.content).not.toContain('personal/b.md');
  });

  it('respects limit', () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makeFile(`n${i}.md`, i),
    );
    const app = makeApp({ files });
    const result = runRecentNotes(app, { limit: 2 });
    const pathLines = result.content.split('\n').filter((l) => l.endsWith('.md'));
    expect(pathLines.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

describe('runOutline', () => {
  it('returns heading tree and link/tag counts', () => {
    const a = makeFile('a.md');
    const app = makeApp({
      files: [a],
      caches: {
        'a.md': {
          headings: [
            { level: 1, heading: 'Title' },
            { level: 2, heading: 'Section' },
          ],
          tags: [{ tag: '#foo' }, { tag: '#bar' }],
        },
      },
      resolvedLinks: { 'a.md': { 'b.md': 1, 'c.md': 1 } },
    });
    const result = runOutline(app, { path: 'a.md' });
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('## Section');
    expect(result.content).toContain('links: 2');
    expect(result.content).toContain('tags: 2');
  });

  it('returns error for missing note', () => {
    const app = makeApp({ files: [] });
    const result = runOutline(app, { path: 'missing.md' });
    expect(result.is_error).toBe(true);
  });

  it('handles notes with no headings gracefully', () => {
    const a = makeFile('bare.md');
    const app = makeApp({ files: [a], caches: { 'bare.md': {} } });
    const result = runOutline(app, { path: 'bare.md' });
    expect(result.content).toContain('(none)');
  });
});

// ---------------------------------------------------------------------------
// search_in_folder
// ---------------------------------------------------------------------------

describe('runSearchInFolder', () => {
  it('finds substring matches scoped to the folder', async () => {
    const a = makeFile('work/task.md');
    const b = makeFile('personal/journal.md');
    const app = makeApp({
      files: [a, b],
      contents: {
        'work/task.md': 'Fix the login button on the dashboard',
        'personal/journal.md': 'login thoughts today',
      },
    });
    const result = await runSearchInFolder(app, {
      query: 'login',
      folder: 'work',
    });
    expect(result.content).toContain('work/task.md');
    expect(result.content).not.toContain('personal/journal.md');
  });

  it('returns no matches when query not found', async () => {
    const a = makeFile('work/note.md');
    const app = makeApp({
      files: [a],
      contents: { 'work/note.md': 'nothing relevant here' },
    });
    const result = await runSearchInFolder(app, {
      query: 'xyzzy',
      folder: 'work',
    });
    expect(result.content).toBe('(no matches)');
  });

  it('returns error for missing query', async () => {
    const app = makeApp({ files: [] });
    const result = await runSearchInFolder(app, { folder: 'work' });
    expect(result.is_error).toBe(true);
  });

  it('returns error for missing folder', async () => {
    const app = makeApp({ files: [] });
    const result = await runSearchInFolder(app, { query: 'hello' });
    expect(result.is_error).toBe(true);
  });

  it('respects limit', async () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`work/n${i}.md`),
    );
    const contents: Record<string, string> = {};
    for (const f of files) contents[f.path] = 'needle in a haystack';
    const app = makeApp({ files, contents });
    const result = await runSearchInFolder(app, {
      query: 'needle',
      folder: 'work',
      limit: 3,
    });
    expect(result.content.split('\n').length).toBe(3);
  });
});
