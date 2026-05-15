import { describe, expect, it } from 'vitest';
import { buildScribianBaseline } from './scribian-baseline';

describe('buildScribianBaseline', () => {
  it('mentions the configured memory path verbatim', () => {
    const out = buildScribianBaseline({ memoryPath: 'PKM/Memory.md' });
    expect(out).toContain('PKM/Memory.md');
  });

  it('falls back to the default memory path when input is empty', () => {
    const out = buildScribianBaseline({ memoryPath: '' });
    expect(out).toContain('Scribian/Memory.md');
  });

  it('falls back when memoryPath is whitespace', () => {
    const out = buildScribianBaseline({ memoryPath: '   ' });
    expect(out).toContain('Scribian/Memory.md');
  });

  it('names every memory tool so Claude can route to them', () => {
    const out = buildScribianBaseline({ memoryPath: 'Memory.md' });
    expect(out).toContain('remember_fact');
    expect(out).toContain('update_memory');
    expect(out).toContain('forget_fact');
  });

  it('names every vault tool so Claude knows the surface', () => {
    const out = buildScribianBaseline({ memoryPath: 'Memory.md' });
    expect(out).toContain('read_note');
    expect(out).toContain('list_notes');
    expect(out).toContain('search_vault');
    expect(out).toContain('find_related');
    expect(out).toContain('write_note');
    expect(out).toContain('append_to_note');
  });

  it('frames scribian as iPad/iOS in Obsidian', () => {
    const out = buildScribianBaseline({ memoryPath: 'Memory.md' });
    expect(out.toLowerCase()).toContain('ipad');
    expect(out).toContain('Obsidian');
  });

  it('states the vault-action-default principle', () => {
    const out = buildScribianBaseline({ memoryPath: 'Memory.md' });
    // The exact wording can drift, but the core idea — proposing a
    // vault destination as the default closing move — must be present.
    expect(out.toLowerCase()).toMatch(
      /propose where it should land|propose the write|landing in.*vault/,
    );
  });
});
