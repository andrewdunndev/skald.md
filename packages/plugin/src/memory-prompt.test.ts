import { describe, expect, it } from 'vitest';
// Import TFile from the test-side mock module path. At runtime vitest
// also aliases 'obsidian' → this same module, so `f instanceof TFile`
// in the source-under-test refers to the same class as `new TFile()`
// here. TypeScript's tsc sees the real obsidian.d.ts (no public ctor)
// for source imports; this relative-path import keeps tests typed
// against the mock's public ctor without disturbing source typing.
import { TFile } from '../../../tests/obsidian-mock';
import { buildMemorySection } from './memory-prompt';

function mockApp(files: Record<string, string>) {
  return {
    vault: {
      getAbstractFileByPath: (p: string) =>
        p in files ? new TFile(p) : null,
      cachedRead: async (f: TFile) =>
        f.path in files ? files[f.path] : '',
    },
  } as unknown as import('obsidian').App;
}

describe('buildMemorySection', () => {
  it('returns null when memory is disabled', async () => {
    const app = mockApp({ 'Scribian/Memory.md': 'My memory' });
    const out = await buildMemorySection(app, {
      enabled: false,
      path: 'Scribian/Memory.md',
    });
    expect(out).toBeNull();
  });

  it('returns null when path is empty', async () => {
    const app = mockApp({});
    const out = await buildMemorySection(app, { enabled: true, path: '' });
    expect(out).toBeNull();
  });

  it('renders empty-memory placeholder when the file is missing', async () => {
    const app = mockApp({});
    const out = await buildMemorySection(app, {
      enabled: true,
      path: 'Scribian/Memory.md',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Scribian/Memory.md');
    expect(out).toContain('<memory>');
    expect(out).toContain('(empty — no memories saved yet)');
    expect(out).toContain('</memory>');
  });

  it('embeds the memory content inside the <memory> block', async () => {
    const app = mockApp({
      'Scribian/Memory.md': 'Bailey is allergic to chicken.',
    });
    const out = await buildMemorySection(app, {
      enabled: true,
      path: 'Scribian/Memory.md',
    });
    expect(out).toContain('<memory>\nBailey is allergic to chicken.\n</memory>');
  });

  it('mentions the path so Claude knows where to write updates', async () => {
    const app = mockApp({ 'inbox/memory.md': 'X' });
    const out = await buildMemorySection(app, {
      enabled: true,
      path: 'inbox/memory.md',
    });
    expect(out).toContain('`inbox/memory.md`');
    expect(out).toContain('write_note');
    expect(out).toContain('edit_note');
  });
});
