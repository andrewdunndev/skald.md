/**
 * saveConversation manual-edit guard tests.
 *
 * The conversation note is re-rendered and re-saved every turn. These
 * tests pin the safety-critical contract added in the vault-data-safety
 * pass: a machine re-save must NOT clobber a note the user hand-edited
 * between turns. saveConversation re-reads the live on-disk content inside
 * vault.process and skips the overwrite when it diverges from the content
 * skald last wrote for that conversation id.
 *
 * Pure-ish: the only obsidian surface used is TFile + the vault stub, so
 * these run in the node test environment via the obsidian mock alias.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../tests/obsidian-mock';
import type { Message } from '@skald/protocol';
import {
  saveConversation,
  __resetConversationWriteCache,
} from './conversation-save';
import type { ConversationMeta } from './conversation-store';

const META: ConversationMeta = {
  id: '00000000-0000-0000-0000-000000000abc',
  model: 'claude-sonnet-4-6',
  created: '2026-05-15T08:30:00.000Z',
  updated: '2026-05-15T08:35:00.000Z',
};

const MESSAGES: Message[] = [{ role: 'user', content: 'hello there' }];

/**
 * In-memory vault. `disk` holds the single conversation file's content;
 * `getAbstractFileByPath` returns a TFile once the file exists. `process`
 * re-reads the live `disk` content (what another writer may have changed)
 * and commits whatever the callback returns. `commits` records every body
 * actually written so tests can assert what landed.
 */
function makeApp() {
  const folderPath = 'Skald/Chats';
  let fileExists = false;
  let disk = '';
  const commits: string[] = [];
  const filePath = `${folderPath}/2026-05-15-hello-there-000000.md`;

  const vault = {
    getAbstractFileByPath: vi.fn((p: string) => {
      if (p === folderPath) return new TFile(folderPath); // folder exists
      if (p === filePath && fileExists) return new TFile(filePath);
      return null;
    }),
    createFolder: vi.fn(async () => {}),
    create: vi.fn(async (p: string, body: string) => {
      fileExists = true;
      disk = body;
      commits.push(body);
      return new TFile(p);
    }),
    process: vi.fn(async (_f: TFile, cb: (current: string) => string) => {
      const next = cb(disk);
      if (next !== disk) {
        disk = next;
        commits.push(next);
      }
      return next;
    }),
    // Present so accidental use of the unguarded primitive is observable.
    modify: vi.fn(async () => {}),
  };

  return {
    app: { vault } as unknown as App,
    vault,
    commits,
    setDisk: (s: string) => {
      disk = s;
    },
    getDisk: () => disk,
  };
}

beforeEach(() => {
  __resetConversationWriteCache();
});

describe('saveConversation: first save creates the note', () => {
  it('creates the file and never touches the unguarded modify', async () => {
    const h = makeApp();
    const file = await saveConversation(h.app, 'Skald/Chats', META, MESSAGES);
    expect(file).not.toBeNull();
    expect(h.vault.create).toHaveBeenCalledTimes(1);
    expect(h.vault.modify).not.toHaveBeenCalled();
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]).toContain('hello there');
  });
});

describe('saveConversation: re-save when the note is unchanged', () => {
  it('overwrites via vault.process when on-disk content is still skald-owned', async () => {
    const h = makeApp();
    await saveConversation(h.app, 'Skald/Chats', META, MESSAGES); // create
    // Same conversation, one more turn: the on-disk content still equals
    // what skald last wrote, so the re-save commits.
    const next: Message[] = [
      ...MESSAGES,
      { role: 'assistant', content: [{ type: 'text', text: 'hi back' } as any] },
    ];
    await saveConversation(h.app, 'Skald/Chats', META, next);
    expect(h.vault.process).toHaveBeenCalledTimes(1);
    expect(h.getDisk()).toContain('hi back');
    expect(h.vault.modify).not.toHaveBeenCalled();
  });
});

describe('saveConversation: manual-edit guard', () => {
  it('does NOT clobber a user-edited conversation note', async () => {
    const h = makeApp();
    await saveConversation(h.app, 'Skald/Chats', META, MESSAGES); // create

    // The user opens the saved note and hand-edits it between turns.
    const userEdit =
      '---\nskald-conversation-id: ' +
      META.id +
      '\n---\n\n## You\n\nMy own careful notes — DO NOT LOSE.\n';
    h.setDisk(userEdit);

    // Next turn re-saves. The guard must detect the divergence and skip the
    // overwrite, preserving the user's edit. FAILS under the original bug
    // (unguarded vault.modify every turn) or if the divergence check is
    // dropped — the user's edit would be discarded.
    const next: Message[] = [
      ...MESSAGES,
      { role: 'assistant', content: [{ type: 'text', text: 'new turn' } as any] },
    ];
    const result = await saveConversation(h.app, 'Skald/Chats', META, next);

    expect(result).not.toBeNull(); // returns the existing file, no error
    expect(h.getDisk()).toBe(userEdit); // edit preserved verbatim
    expect(h.getDisk()).toContain('DO NOT LOSE');
    expect(h.getDisk()).not.toContain('new turn'); // proposal NOT committed
    expect(h.vault.modify).not.toHaveBeenCalled();
    // process was invoked but committed nothing (callback returned current).
    expect(h.commits).toHaveLength(1); // only the original create
  });

  it('resumes overwriting once skald re-owns the content', async () => {
    // After a divergence-skip, if the on-disk content later matches what
    // skald last wrote again, normal re-saves resume. (The cache snapshot
    // is from the last successful write, so this asserts the skip path does
    // not poison future saves.)
    const h = makeApp();
    await saveConversation(h.app, 'Skald/Chats', META, MESSAGES); // create
    const owned = h.getDisk();

    // diverge + skip
    h.setDisk('user edited');
    await saveConversation(h.app, 'Skald/Chats', META, [
      ...MESSAGES,
      { role: 'assistant', content: [{ type: 'text', text: 'skipped' } as any] },
    ]);
    expect(h.getDisk()).toBe('user edited');

    // user reverts the file to the skald-owned content; next save commits.
    h.setDisk(owned);
    await saveConversation(h.app, 'Skald/Chats', META, [
      ...MESSAGES,
      { role: 'assistant', content: [{ type: 'text', text: 'resumed' } as any] },
    ]);
    expect(h.getDisk()).toContain('resumed');
  });
});
