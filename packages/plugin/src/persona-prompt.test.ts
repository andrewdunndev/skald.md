import { describe, expect, it } from 'vitest';
// See memory-prompt.test.ts for the import-from-mock-path rationale.
import { TFile } from '../../../tests/obsidian-mock';
import { buildPersonaSection } from './persona-prompt';

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

describe('buildPersonaSection', () => {
  it('returns null when path is empty', async () => {
    const app = mockApp({});
    expect(await buildPersonaSection(app, { path: '' })).toBeNull();
  });

  it('returns null when the file does not exist', async () => {
    const app = mockApp({});
    expect(
      await buildPersonaSection(app, { path: 'Scribian/Personas/x.md' }),
    ).toBeNull();
  });

  it('returns the body verbatim when there is no frontmatter', async () => {
    const app = mockApp({
      'Personas/coach.md': 'You are a strict editing coach.',
    });
    expect(await buildPersonaSection(app, { path: 'Personas/coach.md' })).toBe(
      'You are a strict editing coach.',
    );
  });

  it('strips frontmatter and returns the body trimmed', async () => {
    const app = mockApp({
      'Personas/reviewer.md':
        '---\nname: reviewer\ndescription: stern review\n---\n\nBe terse. Lead with criticisms.\n',
    });
    const out = await buildPersonaSection(app, {
      path: 'Personas/reviewer.md',
    });
    expect(out).toBe('Be terse. Lead with criticisms.');
  });

  it('returns null when body is empty after stripping frontmatter', async () => {
    const app = mockApp({
      'Personas/empty.md': '---\nname: empty\n---\n\n   \n',
    });
    expect(
      await buildPersonaSection(app, { path: 'Personas/empty.md' }),
    ).toBeNull();
  });

  it('does not strip a "---" sequence that is not at the file start', async () => {
    const app = mockApp({
      'Personas/sep.md': 'Top of persona.\n---\nNot frontmatter, a separator.',
    });
    expect(await buildPersonaSection(app, { path: 'Personas/sep.md' })).toBe(
      'Top of persona.\n---\nNot frontmatter, a separator.',
    );
  });
});
