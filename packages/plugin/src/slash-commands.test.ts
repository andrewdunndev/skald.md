import { describe, expect, it } from 'vitest';
import { TFile } from 'obsidian';
import {
  loadSlashCommands,
  renderCommand,
  type SlashCommand,
} from './slash-commands';

function mockApp(
  files: Array<{ path: string; body: string }>,
  active: { path: string; body: string } | null = null,
) {
  const fileObjs = files.map(({ path }) => new TFile(path));
  const bodyByPath = new Map(files.map(({ path, body }) => [path, body]));
  return {
    vault: {
      getMarkdownFiles: () => fileObjs,
      cachedRead: async (f: TFile) => bodyByPath.get(f.path) ?? '',
    },
    workspace: {
      getActiveFile: () => (active ? new TFile(active.path) : null),
    },
  } as unknown as import('obsidian').App;
}

function mockAppWithActiveBody(activePath: string, body: string) {
  const app = mockApp([{ path: activePath, body }], { path: activePath, body });
  // The renderCommand calls app.vault.cachedRead(activeFile) directly,
  // so we register the path/body via the shared bodyByPath above.
  return app;
}

describe('loadSlashCommands', () => {
  it('returns an empty array when the folder is empty / unset', async () => {
    expect(await loadSlashCommands(mockApp([]), '')).toEqual([]);
    expect(await loadSlashCommands(mockApp([]), 'Scribian/Commands')).toEqual(
      [],
    );
  });

  it('parses command notes inside the configured folder', async () => {
    const app = mockApp([
      {
        path: 'Scribian/Commands/summarize.md',
        body: '---\nname: Summarize\ndescription: bullets the active note\nincludes_active_note: true\n---\n\nSummarize this in 3 bullets:\n\n{{active_note}}',
      },
      {
        path: 'Scribian/Commands/tag.md',
        body: '---\nname: Suggest tags\n---\n\nSuggest tags for {{active_note.title}}.',
      },
      {
        path: 'unrelated.md',
        body: 'not a command',
      },
    ]);
    const cmds = await loadSlashCommands(app, 'Scribian/Commands');
    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.id).sort()).toEqual(['summarize', 'tag']);
    const summarize = cmds.find((c) => c.id === 'summarize')!;
    expect(summarize.name).toBe('Summarize');
    expect(summarize.description).toBe('bullets the active note');
    expect(summarize.includesActiveNote).toBe(true);
    expect(summarize.template.startsWith('Summarize this')).toBe(true);
  });

  it('accepts notes without frontmatter, defaulting name to id', async () => {
    const app = mockApp([
      { path: 'Scribian/Commands/plain.md', body: 'just a body, no fm' },
    ]);
    const cmds = await loadSlashCommands(app, 'Scribian/Commands');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('plain');
    expect(cmds[0].description).toBe('');
    expect(cmds[0].includesActiveNote).toBe(false);
    expect(cmds[0].template).toBe('just a body, no fm');
  });
});

describe('renderCommand', () => {
  const base: SlashCommand = {
    id: 'cmd',
    path: 'cmd.md',
    name: 'cmd',
    description: '',
    includesActiveNote: false,
    template: '',
  };

  it('substitutes {{active_note.title}} with the active file basename', async () => {
    const app = mockAppWithActiveBody('research/foo.md', '# Foo\n\nBody');
    const out = await renderCommand(app, {
      ...base,
      template: 'About {{active_note.title}}.',
    });
    expect(out).toBe('About foo.');
  });

  it('substitutes {{date}} with today as YYYY-MM-DD', async () => {
    const app = mockApp([]);
    const out = await renderCommand(app, {
      ...base,
      template: 'Today is {{date}}.',
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(out).toBe(`Today is ${today}.`);
  });

  it('wraps the active note in <context><file/></context> when includes_active_note is true', async () => {
    const app = mockAppWithActiveBody('notes/bar.md', 'Bar body');
    const out = await renderCommand(app, {
      ...base,
      includesActiveNote: true,
      template: 'Read:\n{{active_note}}',
    });
    expect(out).toContain('<context>');
    expect(out).toContain('<file path="notes/bar.md">');
    expect(out).toContain('Bar body');
    expect(out).toContain('</file>');
    expect(out).toContain('</context>');
  });

  it('expands {{active_note}} to empty when includes_active_note is false', async () => {
    const app = mockAppWithActiveBody('notes/bar.md', 'Bar body');
    const out = await renderCommand(app, {
      ...base,
      includesActiveNote: false,
      template: 'A{{active_note}}B',
    });
    expect(out).toBe('AB');
  });

  it('uses a |default value when the variable is unknown', async () => {
    const app = mockApp([]);
    const out = await renderCommand(app, {
      ...base,
      template: 'Focus on {{focus|key takeaways}}.',
    });
    expect(out).toBe('Focus on key takeaways.');
  });

  it('returns empty for unknown variables with no default', async () => {
    const app = mockApp([]);
    const out = await renderCommand(app, {
      ...base,
      template: 'Hello {{unknown}}.',
    });
    expect(out).toBe('Hello .');
  });
});
