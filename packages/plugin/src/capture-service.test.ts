/**
 * CaptureService.run() integration tests — provider call + folder write.
 *
 * skald is direct-mode only: the plugin calls the provider API and
 * writes the result to the captures folder. Tests exercise:
 *   - the provider call lands on the right endpoint + creates the note
 *   - missing API key produces a clear error before any network call
 *
 * requestUrl is mocked via vi.spyOn on the obsidian alias; the vault
 * is a lightweight in-memory fake.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as obsidian from 'obsidian';
import {
  CaptureService,
  type CaptureServiceConfig,
} from './capture';

// ── helpers ───────────────────────────────────────────────────────────────

/** Minimal vault/app mock for CaptureService.run() tests. */
function makeApp() {
  const created: Array<{ path: string; body: string }> = [];
  const vault = {
    getAbstractFileByPath: (_p: string) => null,
    create: vi.fn(async (path: string, body: string) => {
      created.push({ path, body });
    }),
    createFolder: vi.fn(),
    cachedRead: vi.fn(async () => ''),
    process: vi.fn(),
  };
  const workspace = { openLinkText: vi.fn() };
  return {
    app: { vault, workspace } as unknown as import('obsidian').App,
    created,
  };
}

/**
 * Vault mock where `collisionPath` is treated as already-existing so
 * getAbstractFileByPath returns a truthy value for it. The collision
 * guard in CaptureService.run() should detect this and use the
 * time-suffixed uniquified path instead.
 */
function makeAppWithCollision(collisionPath: string) {
  const created: Array<{ path: string; body: string }> = [];
  const vault = {
    getAbstractFileByPath: (p: string) => (p === collisionPath ? { path: p } : null),
    create: vi.fn(async (path: string, body: string) => {
      created.push({ path, body });
    }),
    createFolder: vi.fn(),
    cachedRead: vi.fn(async () => ''),
    process: vi.fn(),
  };
  const workspace = { openLinkText: vi.fn() };
  return {
    app: { vault, workspace } as unknown as import('obsidian').App,
    created,
  };
}

/** Anthropic-shaped model response for requestUrl mock. */
function anthropicResp(text: string) {
  return { status: 200, text: '', json: { content: [{ type: 'text', text }] } };
}

function makeCfg(
  overrides: Partial<CaptureServiceConfig> = {},
): CaptureServiceConfig {
  return {
    provider: 'anthropic',
    anthropicApiKey: 'sk-ant-test',
    openrouterApiKey: '',
    defaultModel: 'claude-sonnet-4-6',
    openrouterModel: 'anthropic/claude-sonnet-4-6',
    openaiApiKey: '',
    openaiModel: '',
    openaiBaseUrl: '',
    captureFolder: 'Skald/Captures',
    promptPath: '',
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('CaptureService.run()', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    spy = vi.spyOn(obsidian, 'requestUrl');
  });

  it('happy path: calls Anthropic API and creates the note', async () => {
    const { app, created } = makeApp();
    spy.mockResolvedValue(anthropicResp('# Flowers\nRed tulips.'));
    const svc = new CaptureService(app, () => makeCfg());
    const result = await svc.run({
      kind: 'text',
      content: 'tulips are beautiful',
      silent: true,
    });
    expect(result.routedTo).toBe('create');
    expect(result.path).toMatch(/Skald\/Captures\//);
    expect(created[0].body).toBe('# Flowers\nRed tulips.');
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('surfaces provider errors instead of swallowing them (no network call on bad config)', async () => {
    const { app } = makeApp();
    const svc = new CaptureService(
      app,
      () => makeCfg({ anthropicApiKey: '' }),
    );
    await expect(
      svc.run({ kind: 'text', content: 'hello', silent: true }),
    ).rejects.toThrow('No Anthropic API key');
    expect(spy).not.toHaveBeenCalled();
  });

  // Fix 3: same-day same-slug collision → uniquified path, capture is NOT lost.
  it('retries with a time-suffixed path when the computed filename already exists', async () => {
    // The provider returns a title that slugifies to "flowers", so the first
    // candidate path is Skald/Captures/<date>-flowers.md. We pre-populate that
    // path in the vault (simulating a prior same-day capture with the same title).
    // The service must detect the collision and write to a distinct path instead.
    spy.mockResolvedValue(anthropicResp('# Flowers\nRed tulips.'));

    // Determine the first-candidate path by constructing it with the same logic
    // the service uses (date only, no time suffix).
    const today = new Date().toISOString().slice(0, 10);
    const collisionPath = `Skald/Captures/${today}-flowers.md`;

    const { app, created } = makeAppWithCollision(collisionPath);
    const svc = new CaptureService(app, () => makeCfg());
    const result = await svc.run({
      kind: 'text',
      content: 'tulips are beautiful',
      silent: true,
    });

    // Must succeed and land at a path OTHER than the collision path.
    expect(result.routedTo).toBe('create');
    expect(result.path).not.toBe(collisionPath);
    // The new path must still be inside the captures folder.
    expect(result.path).toMatch(/^Skald\/Captures\//);
    // Exactly one note must have been created (no silent drop).
    expect(created).toHaveLength(1);
    expect(created[0].body).toBe('# Flowers\nRed tulips.');
  });
});
