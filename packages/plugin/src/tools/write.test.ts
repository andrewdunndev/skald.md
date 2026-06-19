import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../../tests/obsidian-mock';
import {
  runRememberFact,
  runUpdateMemory,
  runForgetFact,
} from './memory';
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
