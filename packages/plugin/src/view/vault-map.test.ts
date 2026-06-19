import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../../tests/obsidian-mock';
import { buildVaultMap } from './vault-map';

/** Build a mock App whose vault exposes the given markdown paths. */
function mockApp(paths: string[]): App {
  const files = paths.map((p) => new TFile(p));
  return {
    vault: {
      getMarkdownFiles: () => files,
    },
  } as unknown as App;
}

describe('buildVaultMap: folder tree + counts', () => {
  it('renders top-level folders with per-folder note counts', () => {
    const out = buildVaultMap(
      mockApp([
        '0_andrew/a.md',
        '0_andrew/b.md',
        '2_projects/x.md',
        '2_projects/y.md',
        '2_projects/z.md',
      ]),
    );
    expect(out).toContain('## Vault structure');
    expect(out).toContain('0_andrew/ (2 notes)');
    expect(out).toContain('2_projects/ (3 notes)');
  });

  it('renders one-level-deep subfolders indented under their parent', () => {
    const out = buildVaultMap(
      mockApp([
        '2_projects/skald/a.md',
        '2_projects/skald/b.md',
        '2_projects/top.md',
      ]),
    );
    expect(out).toContain('2_projects/ (3 notes)');
    expect(out).toContain('  2_projects/skald/ (2 notes)');
  });

  it('groups root-level notes under a "/ (root)" line', () => {
    const out = buildVaultMap(mockApp(['readme.md', 'todo.md']));
    expect(out).toMatch(/^\/ \(2 notes\)/m);
  });

  it('singularizes the count for a single note', () => {
    const out = buildVaultMap(mockApp(['solo/only.md']));
    expect(out).toContain('solo/ (1 note)');
  });

  it('returns empty string for an empty vault', () => {
    expect(buildVaultMap(mockApp([]))).toBe('');
  });
});

describe('buildVaultMap: full note list under threshold', () => {
  it('includes the full note-path list when total <= threshold', () => {
    const out = buildVaultMap(
      mockApp(['a/one.md', 'a/two.md', 'b/three.md']),
      { maxNotesForFullList: 300 },
    );
    expect(out).toContain('## All notes');
    expect(out).toContain('a/one.md');
    expect(out).toContain('a/two.md');
    expect(out).toContain('b/three.md');
  });

  it('emits paths one per line under the All notes heading', () => {
    const out = buildVaultMap(mockApp(['x/p.md', 'x/q.md']), {
      maxNotesForFullList: 10,
    });
    const allNotes = out.slice(out.indexOf('## All notes'));
    expect(allNotes).toContain('x/p.md\nx/q.md');
  });
});

describe('buildVaultMap: folder-only over threshold', () => {
  it('omits the full list and adds a drill-in note when over threshold', () => {
    const paths = Array.from({ length: 12 }, (_, i) => `f/note-${i}.md`);
    const out = buildVaultMap(mockApp(paths), { maxNotesForFullList: 5 });
    expect(out).not.toContain('## All notes');
    expect(out).toContain('12 notes total');
    expect(out).toContain('list_notes');
    // Folder tree is still present.
    expect(out).toContain('f/ (12 notes)');
  });
});

describe('buildVaultMap: size cap fallback', () => {
  it('falls back to folder-tree-only when the full list exceeds the size cap', () => {
    // Many notes with long paths, but UNDER the note-count threshold,
    // so the full-list branch is taken first — then bounced by the
    // byte cap.
    const longSeg = 'very-long-folder-segment-name-padding';
    const paths = Array.from(
      { length: 250 },
      (_, i) => `${longSeg}/${longSeg}/note-with-a-long-name-${i}.md`,
    );
    const out = buildVaultMap(mockApp(paths), { maxNotesForFullList: 300 });
    expect(out.length).toBeLessThanOrEqual(12_288);
    expect(out).not.toContain('## All notes');
    expect(out).toContain('full list elided');
    expect(out).toContain('250 notes total');
  });
});
