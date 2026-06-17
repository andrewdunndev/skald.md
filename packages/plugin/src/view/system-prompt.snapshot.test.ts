/**
 * Snapshot tests for the assembled system prompt. The composition
 * (baseline + persona + harness + memory) is the most consequential
 * string in the app — every chat turn ships it as the system block.
 * Silent drift in this string corrupts Claude's behavior in ways
 * that are very hard to debug from the chat side.
 *
 * Strategy: snapshot the assembled output for each meaningful
 * configuration of settings. Any change to the baseline, the
 * memory-prompt scaffold, or the composition order trips the
 * snapshot. The developer reviews + accepts the new snapshot
 * intentionally instead of discovering the change weeks later.
 */

import { describe, expect, it } from 'vitest';
import { TFile } from '../../../../tests/obsidian-mock';
import { loadSystemPrompt } from './system-prompt';

interface MockFiles {
  [path: string]: string;
}

function mockApp(files: MockFiles) {
  return {
    vault: {
      getAbstractFileByPath: (p: string) =>
        p in files ? new TFile(p) : null,
      cachedRead: async (f: TFile) => files[f.path] ?? '',
      read: async (f: TFile) => files[f.path] ?? '',
    },
  } as unknown as import('obsidian').App;
}

const BASE_SETTINGS = {
  workerUrl: '',
  workerToken: '',
  provider: 'anthropic',
  anthropicApiKey: '',
  openrouterApiKey: '',
  defaultModel: 'claude-sonnet-4-6',
  openrouterModel: '',
  harnessFolder: '',
  savedNotesFolder: '',
  chatsFolder: '',
  logsFolder: '',
  memoryEnabled: false,
  memoryPath: '',
  personasFolder: '',
  activePersona: '',
  commandsFolder: '',
  capturesFolder: '',
  capturePromptPath: '',
  captureMode: 'auto-route',
  startersPath: '',
} as unknown as import('../settings').ScribianSettings;

describe('loadSystemPrompt snapshot', () => {
  it('baseline only — direct mode (no persona, no memory, no harness)', async () => {
    const app = mockApp({});
    const out = await loadSystemPrompt(app, {
      ...BASE_SETTINGS,
      connectionMode: 'direct',
    } as unknown as import('../settings').ScribianSettings);
    expect(out).toMatchSnapshot();
  });

  it('baseline only — worker mode (find_related guidance present)', async () => {
    const app = mockApp({});
    const out = await loadSystemPrompt(app, {
      ...BASE_SETTINGS,
      connectionMode: 'worker',
    } as unknown as import('../settings').ScribianSettings);
    expect(out).toMatchSnapshot();
  });

  it('baseline + memory (small note, no prune nudge)', async () => {
    const app = mockApp({
      'Scribian/Memory.md': 'Bailey is allergic to chicken.',
    });
    const out = await loadSystemPrompt(app, {
      ...BASE_SETTINGS,
      memoryEnabled: true,
      memoryPath: 'Scribian/Memory.md',
    });
    expect(out).toMatchSnapshot();
  });

  it('baseline + persona', async () => {
    const app = mockApp({
      'Scribian/Personas/coach.md':
        '---\nname: coach\n---\nYou are a no-nonsense coach. Push back hard.',
    });
    const out = await loadSystemPrompt(app, {
      ...BASE_SETTINGS,
      activePersona: 'Scribian/Personas/coach.md',
    });
    expect(out).toMatchSnapshot();
  });

  it('full stack: persona + harness + memory', async () => {
    const app = mockApp({
      'Scribian/Personas/editor.md':
        'You are a terse editor. Strunk-and-White discipline.',
      '.claude/CLAUDE.md': 'Project context: this is a writing assistant.',
      'Scribian/Memory.md':
        'User prefers two-sentence paragraphs.\nDislikes the word "leverage".',
    });
    const out = await loadSystemPrompt(app, {
      ...BASE_SETTINGS,
      activePersona: 'Scribian/Personas/editor.md',
      harnessFolder: '.claude',
      memoryEnabled: true,
      memoryPath: 'Scribian/Memory.md',
    });
    expect(out).toMatchSnapshot();
  });
});
