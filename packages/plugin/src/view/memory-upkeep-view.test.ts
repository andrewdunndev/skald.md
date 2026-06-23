/**
 * runMemoryUpkeepView guard tests.
 *
 * The view layer bridges the pure memory-upkeep model call to vault I/O
 * and the approval flow. These tests pin the safety-critical contract:
 *   - the memoryEnabled setting actually gates the model call
 *   - a proposal routes through approval (kind=overwrite, path=memoryPath)
 *   - NO vault write happens unless approval resolves true
 *   - the model is utilityModel(settings), not a hardcoded string
 *
 * proposeMemoryUpkeep and utilityModel are mocked at the module boundary
 * so we observe exactly what runMemoryUpkeepView passes them without
 * making a network call.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const proposeMemoryUpkeep = vi.fn();
const utilityModel = vi.fn();

vi.mock('../memory-upkeep', () => ({
  proposeMemoryUpkeep: (...args: unknown[]) => proposeMemoryUpkeep(...args),
}));
vi.mock('../provider-capabilities', () => ({
  utilityModel: (...args: unknown[]) => utilityModel(...args),
}));

import { runMemoryUpkeepView, UpkeepInFlightGate } from './memory-upkeep-view';
import type { SkaldSettings } from '../settings';
import type { ChatSession } from '../chat-session';
import type { ApprovalManager } from '../approval-manager';

// ── fakes ───────────────────────────────────────────────────────────────────

function makeVault(opts: { onDiskContent?: string } = {}) {
  const modify = vi.fn(async () => {});
  const create = vi.fn(async () => {});
  // The TOCTOU-guarded write re-reads the live on-disk content inside
  // vault.process. `onDiskContent` is what process() sees as `current`
  // when its callback fires — defaults to the same snapshot cachedRead
  // returned (the happy path: nothing changed under us). A test can pass
  // a divergent value to simulate a concurrent manual edit.
  const onDisk = opts.onDiskContent ?? 'old memory body';
  const processedWith: string[] = [];
  const process = vi.fn(
    async (_f: unknown, cb: (current: string) => string) => {
      const result = cb(onDisk);
      processedWith.push(result);
      return result;
    },
  );
  return {
    modify,
    create,
    process,
    processedWith,
    createFolder: vi.fn(async () => {}),
    // Existing file so the write path takes the overwrite branch.
    getAbstractFileByPath: vi.fn((_p: string) => existingFile),
    cachedRead: vi.fn(async () => 'old memory body'),
  };
}

// A TFile instance so `file instanceof TFile` is true inside the view.
// The runtime obsidian mock's TFile takes (path); the published type
// declarations declare a 0-arg constructor, so cast through the mock
// shape to construct one for the test.
import { TFile } from 'obsidian';
import * as obsidianMod from 'obsidian';
const existingFile = new (TFile as unknown as new (p: string) => TFile)('Memory.md');

function makeApp(opts: { onDiskContent?: string } = {}) {
  const vault = makeVault(opts);
  return { app: { vault } as unknown as import('obsidian').App, vault };
}

function makeApprovals(decision: boolean) {
  const request = vi.fn(async () => decision);
  return { request } as unknown as ApprovalManager & {
    request: ReturnType<typeof vi.fn>;
  };
}

function makeSettings(over: Partial<SkaldSettings> = {}): SkaldSettings {
  return {
    provider: 'anthropic',
    anthropicApiKey: 'sk-ant-test',
    openrouterApiKey: '',
    defaultModel: 'claude-sonnet-4-6',
    openrouterModel: '',
    memoryEnabled: true,
    memoryPath: 'Memory.md',
    ...over,
  } as SkaldSettings;
}

function makeSession(
  messages: { role: string; content: string }[],
  conversationId = 'conv-1',
): ChatSession {
  return { getMessages: () => messages, conversationId } as unknown as ChatSession;
}

beforeEach(() => {
  proposeMemoryUpkeep.mockReset();
  utilityModel.mockReset();
  utilityModel.mockReturnValue('claude-haiku-4-5');
});

// ── tests ───────────────────────────────────────────────────────────────────

describe('runMemoryUpkeepView: memoryEnabled guard', () => {
  it('does NOT call the model or write when memoryEnabled is false', async () => {
    // Passes on correct code; FAILS under mutation "drop the
    // !settings.memoryEnabled guard" — the model would be called.
    const { app, vault } = makeApp();
    const approvals = makeApprovals(true);
    await runMemoryUpkeepView({
      app,
      settings: makeSettings({ memoryEnabled: false }),
      session: makeSession([{ role: 'user', content: 'hi' }]),
      approvals,
      provider: 'anthropic',
    });
    expect(proposeMemoryUpkeep).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });
});

describe('runMemoryUpkeepView: approval routing', () => {
  it('requests approval with kind=overwrite and path=memoryPath', async () => {
    // Passes on correct code; FAILS under mutation that changes the
    // approval kind or path, or skips approval entirely.
    proposeMemoryUpkeep.mockResolvedValue('new memory body');
    const { app } = makeApp();
    const approvals = makeApprovals(true);
    await runMemoryUpkeepView({
      app,
      settings: makeSettings({ memoryPath: 'Notes/Memory.md' }),
      session: makeSession([{ role: 'user', content: 'remember X' }]),
      approvals,
      provider: 'anthropic',
    });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    const arg = (approvals.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.kind).toBe('overwrite');
    expect(arg.path).toBe('Notes/Memory.md');
    expect(arg.after).toBe('new memory body');
  });
});

describe('runMemoryUpkeepView: write requires approval', () => {
  it('NEVER writes the vault when approval resolves false', async () => {
    // The safety test. Passes on correct code; FAILS under mutation
    // "bypass approval" (write regardless of the resolved decision).
    proposeMemoryUpkeep.mockResolvedValue('new memory body');
    const { app, vault } = makeApp();
    const approvals = makeApprovals(false);
    await runMemoryUpkeepView({
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'remember X' }]),
      approvals,
      provider: 'anthropic',
    });
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(vault.process).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });
  // The approval-true write path is exercised by the conversationId
  // "writes when unchanged" test below (same vault.modify assertion with
  // approval resolved true), so the standalone happy-path write was
  // removed as redundant.
});

// ── Fix 3: in-flight guard + conversationId race ───────────────────────────────

describe('runMemoryUpkeepView: in-flight guard', () => {
  it('does NOT start a second proposal while one upkeep is in flight', async () => {
    // First call: hold the proposal pending (never resolves) so the gate
    // stays acquired across the second call. Second call shares the gate.
    // Passes on correct code; FAILS under mutation "remove the in-flight
    // guard" — proposeMemoryUpkeep would be called twice.
    const gate = new UpkeepInFlightGate();
    let resolveFirst!: (v: string | null) => void;
    proposeMemoryUpkeep.mockReturnValueOnce(
      new Promise((res) => { resolveFirst = res; }),
    );

    const { app } = makeApp();
    const approvals = makeApprovals(true);
    const common = {
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'x' }]),
      approvals,
      provider: 'anthropic' as const,
      inFlight: gate,
    };

    const first = runMemoryUpkeepView(common); // acquires gate, awaits proposal
    await Promise.resolve(); // let the first call reach the gate acquire + await

    // Second trigger while the first is pending:
    await runMemoryUpkeepView(common);
    expect(proposeMemoryUpkeep).toHaveBeenCalledTimes(1); // second was gated out

    resolveFirst(null); // let the first finish and release the gate
    await first;
  });

  it('allows a later upkeep once the prior one has released the gate', async () => {
    const gate = new UpkeepInFlightGate();
    proposeMemoryUpkeep.mockResolvedValue(null);
    const { app } = makeApp();
    const common = {
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'x' }]),
      approvals: makeApprovals(true),
      provider: 'anthropic' as const,
      inFlight: gate,
    };
    await runMemoryUpkeepView(common);
    await runMemoryUpkeepView(common);
    expect(proposeMemoryUpkeep).toHaveBeenCalledTimes(2);
  });
});

describe('runMemoryUpkeepView: conversationId race guard', () => {
  it('SKIPS the vault write when the conversation changed between trigger and write', async () => {
    // Snapshot conv-1 at trigger; report conv-2 active at write time.
    // Passes on correct code; FAILS under mutation "remove the
    // conversationId guard" — the stale overwrite would be written.
    proposeMemoryUpkeep.mockResolvedValue('new memory body');
    const { app, vault } = makeApp();
    await runMemoryUpkeepView({
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'x' }], 'conv-1'),
      approvals: makeApprovals(true),
      provider: 'anthropic',
      getActiveConversationId: () => 'conv-2', // changed mid-flight
    });
    expect(vault.process).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('writes when the conversation is unchanged between trigger and write', async () => {
    proposeMemoryUpkeep.mockResolvedValue('new memory body');
    // on-disk content still equals the snapshot cachedRead returned, so the
    // TOCTOU guard passes and the proposal commits via vault.process.
    const { app, vault } = makeApp({ onDiskContent: 'old memory body' });
    await runMemoryUpkeepView({
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'x' }], 'conv-1'),
      approvals: makeApprovals(true),
      provider: 'anthropic',
      getActiveConversationId: () => 'conv-1', // still the same conversation
    });
    expect(vault.process).toHaveBeenCalledTimes(1);
    expect(vault.processedWith).toEqual(['new memory body']);
    // Never the hand-rolled, unguarded modify.
    expect(vault.modify).not.toHaveBeenCalled();
  });
});

// ── Fix A: TOCTOU guard on the memory-note overwrite ─────────────────────────

describe('runMemoryUpkeepView: memory-note TOCTOU guard', () => {
  it('does NOT clobber a memory note that diverged since the proposal — aborts with a Notice', async () => {
    // The snapshot shown in the diff card was 'old memory body'. By the
    // time the user approves, the note on disk has been hand-edited to
    // something else. The guarded write must refuse rather than discard
    // that manual edit. Passes on correct code; FAILS if the write is
    // routed through an unguarded vault.modify (the original bug) or if
    // the snapshot comparison is dropped.
    proposeMemoryUpkeep.mockResolvedValue('new memory body');
    // Spy on the Notice constructor. mockImplementation keeps it `new`-able
    // (the real class needs `new`); we only care that it was instantiated.
    const noticeSpy = vi
      .spyOn(obsidianMod, 'Notice')
      .mockImplementation(() => ({}) as obsidianMod.Notice);
    const { app, vault } = makeApp({
      onDiskContent: 'MANUALLY EDITED memory body — keep me!',
    });
    await runMemoryUpkeepView({
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'x' }], 'conv-1'),
      approvals: makeApprovals(true),
      provider: 'anthropic',
      getActiveConversationId: () => 'conv-1',
    });
    // The guard ran inside vault.process and returned the on-disk content
    // unchanged — the proposal was NOT committed.
    expect(vault.process).toHaveBeenCalledTimes(1);
    expect(vault.processedWith).toEqual([
      'MANUALLY EDITED memory body — keep me!',
    ]);
    expect(vault.processedWith).not.toContain('new memory body');
    // Never falls back to the unguarded overwrite.
    expect(vault.modify).not.toHaveBeenCalled();
    // The user is told the update was skipped.
    expect(noticeSpy).toHaveBeenCalledTimes(1);
    noticeSpy.mockRestore();
  });
});

describe('runMemoryUpkeepView: provider-agnostic model', () => {
  it('passes utilityModel(settings), honoring the utilityModel override', async () => {
    // utilityModel resolves the override; the view must forward whatever
    // it returns, not a hardcoded id. Passes on correct code; FAILS
    // under mutation "hardcode the model" (e.g. 'claude-haiku-4-5').
    utilityModel.mockReturnValue('my/override-model');
    proposeMemoryUpkeep.mockResolvedValue(null); // no-op proposal, stops early
    const settings = makeSettings({ utilityModel: 'my/override-model' });
    const { app } = makeApp();
    await runMemoryUpkeepView({
      app,
      settings,
      session: makeSession([{ role: 'user', content: 'x' }]),
      approvals: makeApprovals(true),
      provider: 'anthropic',
    });
    expect(utilityModel).toHaveBeenCalledWith(settings);
    const call = proposeMemoryUpkeep.mock.calls[0][0];
    expect(call.model).toBe('my/override-model');
  });
});
