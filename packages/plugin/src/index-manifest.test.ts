import { describe, expect, it } from 'vitest';
import {
  applyDiff,
  diffAgainstManifest,
  emptyManifest,
  MANIFEST_VERSION,
  type FileInfo,
  type IndexManifest,
} from './index-manifest';

const f = (
  path: string,
  mtime: number,
  size: number,
): FileInfo => ({ path, mtime, size });

describe('emptyManifest', () => {
  it('returns a versioned manifest with no entries', () => {
    expect(emptyManifest()).toEqual({
      version: MANIFEST_VERSION,
      entries: {},
    });
  });
});

describe('diffAgainstManifest', () => {
  it('classifies all current files as added when manifest is empty', () => {
    const diff = diffAgainstManifest(
      [f('a.md', 1, 10), f('b.md', 2, 20)],
      emptyManifest(),
    );
    expect(diff.added.map((x) => x.path)).toEqual(['a.md', 'b.md']);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('reports paths in manifest missing from current as deleted', () => {
    const manifest: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: {
        'gone.md': { mtime: 100, size: 50, lastEmbedded: 0 },
        'kept.md': { mtime: 200, size: 60, lastEmbedded: 0 },
      },
    };
    const diff = diffAgainstManifest([f('kept.md', 200, 60)], manifest);
    expect(diff.deleted).toEqual(['gone.md']);
    expect(diff.unchanged).toEqual(['kept.md']);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it('flags a path as modified when mtime changed', () => {
    const manifest: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: { 'x.md': { mtime: 100, size: 50, lastEmbedded: 0 } },
    };
    const diff = diffAgainstManifest([f('x.md', 200, 50)], manifest);
    expect(diff.modified.map((x) => x.path)).toEqual(['x.md']);
    expect(diff.added).toEqual([]);
    expect(diff.deleted).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('flags a path as modified when size changed even if mtime matches', () => {
    const manifest: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: { 'x.md': { mtime: 100, size: 50, lastEmbedded: 0 } },
    };
    const diff = diffAgainstManifest([f('x.md', 100, 75)], manifest);
    expect(diff.modified.map((x) => x.path)).toEqual(['x.md']);
  });

  it('leaves identical entries in unchanged, not modified', () => {
    const manifest: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: { 'x.md': { mtime: 100, size: 50, lastEmbedded: 999 } },
    };
    const diff = diffAgainstManifest([f('x.md', 100, 50)], manifest);
    expect(diff.unchanged).toEqual(['x.md']);
    expect(diff.modified).toEqual([]);
  });

  it('mixes adds + mods + deletes + unchanged correctly', () => {
    const manifest: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: {
        'old.md': { mtime: 100, size: 10, lastEmbedded: 0 },
        'kept.md': { mtime: 200, size: 20, lastEmbedded: 0 },
        'edited.md': { mtime: 300, size: 30, lastEmbedded: 0 },
      },
    };
    const diff = diffAgainstManifest(
      [
        f('new.md', 400, 40), // added
        f('kept.md', 200, 20), // unchanged
        f('edited.md', 350, 30), // modified (mtime changed)
      ],
      manifest,
    );
    expect(diff.added.map((x) => x.path)).toEqual(['new.md']);
    expect(diff.modified.map((x) => x.path)).toEqual(['edited.md']);
    expect(diff.deleted).toEqual(['old.md']);
    expect(diff.unchanged).toEqual(['kept.md']);
  });
});

describe('applyDiff', () => {
  it('adds new entries with the embedded timestamp', () => {
    const m = applyDiff(
      emptyManifest(),
      {
        added: [f('a.md', 1, 10)],
        modified: [],
        deleted: [],
        unchanged: [],
      },
      999,
    );
    expect(m.entries['a.md']).toEqual({
      mtime: 1,
      size: 10,
      lastEmbedded: 999,
    });
  });

  it('updates existing entries on modified', () => {
    const m0: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: { 'x.md': { mtime: 100, size: 50, lastEmbedded: 0 } },
    };
    const m1 = applyDiff(
      m0,
      {
        added: [],
        modified: [f('x.md', 200, 75)],
        deleted: [],
        unchanged: [],
      },
      1234,
    );
    expect(m1.entries['x.md']).toEqual({
      mtime: 200,
      size: 75,
      lastEmbedded: 1234,
    });
  });

  it('removes deleted entries', () => {
    const m0: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: {
        'gone.md': { mtime: 100, size: 50, lastEmbedded: 0 },
        'kept.md': { mtime: 200, size: 60, lastEmbedded: 0 },
      },
    };
    const m1 = applyDiff(m0, {
      added: [],
      modified: [],
      deleted: ['gone.md'],
      unchanged: ['kept.md'],
    });
    expect(m1.entries['gone.md']).toBeUndefined();
    expect(m1.entries['kept.md']).toBeDefined();
  });

  it('does not mutate the input manifest', () => {
    const m0: IndexManifest = {
      version: MANIFEST_VERSION,
      entries: { 'x.md': { mtime: 100, size: 50, lastEmbedded: 0 } },
    };
    applyDiff(m0, {
      added: [],
      modified: [f('x.md', 200, 60)],
      deleted: [],
      unchanged: [],
    });
    // Original manifest still has the old values
    expect(m0.entries['x.md']).toEqual({
      mtime: 100,
      size: 50,
      lastEmbedded: 0,
    });
  });
});
