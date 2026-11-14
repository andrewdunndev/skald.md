import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../../tests/obsidian-mock';
import {
  runRememberFact,
  runUpdateMemory,
  runForgetFact,
} from './memory';
import { runAppendToNote, runEditNote, runWriteNote } from './write';
import type { WriteProposal } from './context';

/** Minimal App stub cast to the real Obsidian App surface. The memory
 * tools only touch vault.getAbstractFileByPath + vault.read; we don't
 * reach vault.modify because approve returns false in the assertion
 * tests (the rejection path doesn't write to the vault). Vitest's
 * resolve.alias maps `obsidian` → tests/obsidian-mock.ts at runtime
 * so this TFile instance is recognized by the production code's
 * `instanceof TFile` check. */
function makeApp(files: Record<string, string>): App {
  const stub = {
    vault: {
      getAbstractFileByPath: (p: string) =>
        p in files ? new TFile(p) : null,
      read: async (file: TFile) => files[file.path] ?? '',
      adapter: { exists: async (p: string) => p in files },
    },
  };
  return stub as unknown as App;
}

describe('memory tool routing', () => {
  it('remember_fact appends to the configured memory path', async () => {
    const app = makeApp({});
    const approve = vi.fn().mockResolvedValue(false);
    await runRememberFact(
      app,
      { fact: 'Bailey is allergic to chicken' },
      'tu_1',
      approve,
      'Skald/Memory.md',
    );
    expect(approve).toHaveBeenCalledOnce();
    const proposal = approve.mock.calls[0][0] as WriteProposal;
    expect(proposal.path).toBe('Skald/Memory.md');
    expect(proposal.kind).toBe('create');
    expect(proposal.after).toContain('Bailey is allergic to chicken');
  });

  it('remember_fact returns a configuration error when memory path is unset', async () => {
    const app = makeApp({});
    const approve = vi.fn();
    const result = await runRememberFact(
      app,
      { fact: 'something' },
      'tu_1',
      approve,
      undefined,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('memory path not configured');
    expect(approve).not.toHaveBeenCalled();
  });

  it('remember_fact rejects an empty fact', async () => {
    const app = makeApp({});
    const approve = vi.fn();
    const result = await runRememberFact(
      app,
      { fact: '   ' },
      'tu_1',
      approve,
      'Skald/Memory.md',
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('empty fact');
    expect(approve).not.toHaveBeenCalled();
  });

  it('update_memory edits the configured memory path with search/replace', async () => {
    const app = makeApp({
      'Skald/Memory.md': 'Bailey is allergic to chicken.\nLikes hiking.',
    });
    const approve = vi.fn().mockResolvedValue(false);
    await runUpdateMemory(
      app,
      { search: 'chicken', replace: 'poultry' },
      'tu_2',
      approve,
      'Skald/Memory.md',
    );
    expect(approve).toHaveBeenCalledOnce();
    const proposal = approve.mock.calls[0][0] as WriteProposal;
    expect(proposal.path).toBe('Skald/Memory.md');
    expect(proposal.kind).toBe('edit');
    expect(proposal.before).toContain('chicken');
    expect(proposal.after).toContain('poultry');
    expect(proposal.after).not.toContain('chicken');
  });

  it('update_memory returns a configuration error when memory path is unset', async () => {
    const app = makeApp({});
    const approve = vi.fn();
    const result = await runUpdateMemory(
      app,
      { search: 'x', replace: 'y' },
      'tu_2',
      approve,
      undefined,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('memory path not configured');
    expect(approve).not.toHaveBeenCalled();
  });

  it('forget_fact removes the fact from the memory note via empty replacement', async () => {
    const app = makeApp({
      'Skald/Memory.md':
        'Bailey is allergic to chicken.\nLikes hiking.',
    });
    const approve = vi.fn().mockResolvedValue(false);
    await runForgetFact(
      app,
      { fact: 'Bailey is allergic to chicken.' },
      'tu_3',
      approve,
      'Skald/Memory.md',
    );
    expect(approve).toHaveBeenCalledOnce();
    const proposal = approve.mock.calls[0][0] as WriteProposal;
    expect(proposal.path).toBe('Skald/Memory.md');
    expect(proposal.kind).toBe('edit');
    expect(proposal.before).toContain('Bailey is allergic');
    expect(proposal.after).not.toContain('Bailey is allergic');
  });

  it('forget_fact returns a configuration error when memory path is unset', async () => {
    const app = makeApp({});
    const approve = vi.fn();
    const result = await runForgetFact(
      app,
      { fact: 'x' },
      'tu_3',
      approve,
      undefined,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('memory path not configured');
    expect(approve).not.toHaveBeenCalled();
  });

  it('forget_fact errors clearly when the fact is not found in memory', async () => {
    const app = makeApp({
      'Skald/Memory.md': 'Likes hiking.',
    });
    const approve = vi.fn();
    const result = await runForgetFact(
      app,
      { fact: 'not present' },
      'tu_3',
      approve,
      'Skald/Memory.md',
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('not found');
    expect(approve).not.toHaveBeenCalled();
  });
});

// ── Fix 1: write_note overwrite TOCTOU guard ──────────────────────────────────

/**
 * Build a minimal App stub for runWriteNote tests.
 *
 * `onDiskContent` is the content that vault.process sees as the "current"
 * on-disk state when its callback is invoked — simulating what another writer
 * may have written between the diff card snapshot and the vault commit.
 *
 * `processedWith` accumulates the return value from the process callback so
 * tests can assert the write was (or wasn't) committed.
 */
function makeWriteApp(opts: {
  /** Content returned by vault.read (the snapshot shown in the diff card). */
  snapshotContent: string;
  /** Content vault.process sees as current when its callback fires (may differ). */
  onDiskContent: string;
}): { app: App; processedWith: string[] } {
  const processedWith: string[] = [];
  const file = new TFile('notes/target.md');

  const app = {
    vault: {
      getAbstractFileByPath: (p: string) =>
        p === 'notes/target.md' ? file : null,
      read: async (_f: TFile) => opts.snapshotContent,
      process: vi.fn(async (_f: TFile, cb: (current: string) => string) => {
        const result = cb(opts.onDiskContent);
        processedWith.push(result);
      }),
      createFolder: async () => {},
      create: vi.fn(async () => {}),
    },
  } as unknown as App;

  return { app, processedWith };
}

describe('runWriteNote: overwrite TOCTOU guard', () => {
  it('aborts with an error when on-disk content changed since the snapshot', async () => {
    // The snapshot shown in the diff card is the OLD content. By the time the
    // user approves, the file has been edited externally to NEW content. The
    // write must refuse rather than discarding those external edits.
    const { app, processedWith } = makeWriteApp({
      snapshotContent: 'original content',
      onDiskContent: 'content changed by another process',
    });

    const approve = vi.fn().mockResolvedValue(true);
    const result = await runWriteNote(
      app,
      { path: 'notes/target.md', content: 'proposed replacement' },
      'tu_toctou',
      approve,
    );

    // Must error — the user's consent was to overwrite 'original content'.
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/changed since/i);

    // vault.process was called but the callback returned the on-disk content
    // unchanged (the guard fired, so the callback returns `current` as-is).
    // The 'proposed replacement' must NOT appear in what process returned.
    expect(processedWith).toHaveLength(1);
    expect(processedWith[0]).toBe('content changed by another process');
    expect(processedWith[0]).not.toBe('proposed replacement');
  });

  it('succeeds when on-disk content is still the same as the snapshot', async () => {
    // File was NOT changed between snapshot and write — happy path.
    const { app, processedWith } = makeWriteApp({
      snapshotContent: 'unchanged content',
      onDiskContent: 'unchanged content',
    });

    const approve = vi.fn().mockResolvedValue(true);
    const result = await runWriteNote(
      app,
      { path: 'notes/target.md', content: 'new proposed content' },
      'tu_toctou_ok',
      approve,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('notes/target.md');
    // process committed the new content.
    expect(processedWith[0]).toBe('new proposed content');
  });
});

describe('write tools: path guard and honest create label', () => {
  function makeGuardApp(opts: {
    indexed?: Record<string, string>;
    folders?: string[];
    onDiskOnly?: string[];
  }): { app: App; create: ReturnType<typeof vi.fn> } {
    const indexed = opts.indexed ?? {};
    const create = vi.fn(async () => {});
    const app = {
      vault: {
        getAbstractFileByPath: (p: string) =>
          p in indexed
            ? new TFile(p)
            : (opts.folders ?? []).includes(p)
              ? { path: p }
              : null,
        read: async (f: TFile) => indexed[f.path] ?? '',
        create,
        createFolder: async () => {},
        adapter: {
          exists: async (p: string) =>
            p in indexed ||
            (opts.folders ?? []).includes(p) ||
            (opts.onDiskOnly ?? []).includes(p),
        },
      },
    } as unknown as App;
    return { app, create };
  }

  it.each([
    ['config dir plugin code', '.obsidian/plugins/x/main.js'],
    ['config dir json', '.obsidian/community-plugins.json'],
    ['hidden folder note', 'notes/.hidden/a.md'],
    ['hidden note', '.secret.md'],
    ['non-markdown file', 'scripts/run.js'],
    ['canvas', 'board.canvas'],
  ])('write_note refuses %s without asking for approval', async (_l, path) => {
    const { app, create } = makeGuardApp({});
    const approve = vi.fn().mockResolvedValue(true);
    const result = await runWriteNote(app, { path, content: 'x' }, 'tu', approve);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('only .md notes');
    expect(approve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('append_to_note and edit_note refuse a config-dir path', async () => {
    const { app, create } = makeGuardApp({});
    const approve = vi.fn().mockResolvedValue(true);
    const appended = await runAppendToNote(
      app,
      { path: '.obsidian/app.json', content: 'x' },
      'tu',
      approve,
    );
    const edited = await runEditNote(
      app,
      { path: '.obsidian/app.json', search: 'a', replace: 'b' },
      'tu',
      approve,
    );
    expect(appended.is_error).toBe(true);
    expect(edited.is_error).toBe(true);
    expect(edited.content).toContain('only .md notes');
    expect(approve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('labels an indexed note as overwrite, a missing one as create', async () => {
    const { app } = makeGuardApp({ indexed: { 'a.md': 'old' } });
    const approve = vi.fn().mockResolvedValue(false);
    await runWriteNote(app, { path: 'a.md', content: 'new' }, 'tu', approve);
    await runWriteNote(app, { path: 'b.md', content: 'new' }, 'tu', approve);
    const kinds = approve.mock.calls.map((c) => (c[0] as WriteProposal).kind);
    expect(kinds).toEqual(['overwrite', 'create']);
  });

  it.each([
    ['a file the index does not know', { onDiskOnly: ['Note.md'] }],
    ['a folder named like a note', { folders: ['Note.md'] }],
  ])('never shows a create card over %s', async (_l, opts) => {
    const { app, create } = makeGuardApp(opts);
    const approve = vi.fn().mockResolvedValue(true);
    for (const run of [runWriteNote, runAppendToNote]) {
      const result = await run(app, { path: 'Note.md', content: 'x' }, 'tu', approve);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('already exists');
    }
    expect(approve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('edit_note replacement is literal', () => {
  it.each(['$$', '$&', '$1', '$`', "$'", '$<n>'])(
    'keeps %s verbatim in the preview and the committed text',
    async (pattern) => {
      const files: Record<string, string> = { 'n.md': 'keep OLD tail' };
      const app = {
        vault: {
          getAbstractFileByPath: (p: string) => (p in files ? new TFile(p) : null),
          read: async (f: TFile) => files[f.path],
          process: async (f: TFile, fn: (c: string) => string) => {
            files[f.path] = fn(files[f.path]);
          },
        },
      } as unknown as App;
      const replace = `cost ${pattern} here`;
      const approve = vi.fn().mockResolvedValue(true);
      const result = await runEditNote(app, { path: 'n.md', search: 'OLD', replace }, 'tu', approve);
      expect(result.is_error).toBeUndefined();
      expect((approve.mock.calls[0][0] as WriteProposal).after).toBe(`keep ${replace} tail`);
      expect(files['n.md']).toBe(`keep ${replace} tail`);
    },
  );
});
