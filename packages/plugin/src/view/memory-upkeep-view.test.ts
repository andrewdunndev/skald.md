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

import { runMemoryUpkeepView } from './memory-upkeep-view';
import type { ScribianSettings } from '../settings';
import type { ChatSession } from '../chat-session';
import type { ApprovalManager } from '../approval-manager';

// ── fakes ───────────────────────────────────────────────────────────────────

function makeVault() {
  const modify = vi.fn(async () => {});
  const create = vi.fn(async () => {});
  return {
    modify,
    create,
    createFolder: vi.fn(async () => {}),
    // Existing file so the write path takes vault.modify.
    getAbstractFileByPath: vi.fn((_p: string) => existingFile),
    cachedRead: vi.fn(async () => 'old memory body'),
  };
}

// A TFile instance so `file instanceof TFile` is true inside the view.
// The runtime obsidian mock's TFile takes (path); the published type
// declarations declare a 0-arg constructor, so cast through the mock
// shape to construct one for the test.
import { TFile } from 'obsidian';
const existingFile = new (TFile as unknown as new (p: string) => TFile)('Memory.md');

function makeApp() {
  const vault = makeVault();
  return { app: { vault } as unknown as import('obsidian').App, vault };
}

function makeApprovals(decision: boolean) {
  const request = vi.fn(async () => decision);
  return { request } as unknown as ApprovalManager & {
    request: ReturnType<typeof vi.fn>;
  };
}

function makeSettings(over: Partial<ScribianSettings> = {}): ScribianSettings {
  return {
    provider: 'anthropic',
    anthropicApiKey: 'sk-ant-test',
    openrouterApiKey: '',
    defaultModel: 'claude-sonnet-4-6',
    openrouterModel: '',
    memoryEnabled: true,
    memoryPath: 'Memory.md',
    ...over,
  } as ScribianSettings;
}

function makeSession(messages: { role: string; content: string }[]): ChatSession {
  return { getMessages: () => messages } as unknown as ChatSession;
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
    expect(vault.modify).not.toHaveBeenCalled();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('writes the vault when approval resolves true', async () => {
    proposeMemoryUpkeep.mockResolvedValue('new memory body');
    const { app, vault } = makeApp();
    const approvals = makeApprovals(true);
    await runMemoryUpkeepView({
      app,
      settings: makeSettings(),
      session: makeSession([{ role: 'user', content: 'remember X' }]),
      approvals,
      provider: 'anthropic',
    });
    expect(vault.modify).toHaveBeenCalledWith(existingFile, 'new memory body');
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
