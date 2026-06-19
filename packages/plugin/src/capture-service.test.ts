/**
 * CaptureService.run() integration tests — mode dispatch + routing.
 *
 * Tests in this file exercise the orchestration logic of CaptureService:
 *   - worker mode calls the Worker endpoint
 *   - direct mode calls the provider API from the plugin
 *   - direct mode silently forces inbox routing (no semanticSearch)
 *   - missing API key or Worker URL produces a clear error
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

/** Anthropic-shaped model response for requestUrl mock. */
function anthropicResp(text: string) {
  return { status: 200, text: '', json: { content: [{ type: 'text', text }] } };
}

/** Worker /capture response for requestUrl mock. */
function workerResp(body: string, title: string) {
  return { status: 200, text: '', json: { body, title } };
}

function makeDirectCfg(
  overrides: Partial<CaptureServiceConfig> = {},
): CaptureServiceConfig {
  return {
    connectionMode: 'direct',
    workerUrl: '',
    workerToken: '',
    provider: 'anthropic',
    anthropicApiKey: 'sk-ant-test',
    openrouterApiKey: '',
    defaultModel: 'claude-sonnet-4-6',
    openrouterModel: 'anthropic/claude-sonnet-4-6',
    captureFolder: 'Skald/Captures',
    promptPath: '',
    mode: 'inbox',
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('CaptureService.run() — direct mode', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    spy = vi.spyOn(obsidian, 'requestUrl');
  });

  it('happy path: calls Anthropic API and creates the note', async () => {
    const { app, created } = makeApp();
    spy.mockResolvedValue(anthropicResp('# Flowers\nRed tulips.'));
    const svc = new CaptureService(app, () => makeDirectCfg());
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

  it('auto-route config is silently forced to inbox (no semanticSearch)', async () => {
    // direct mode lacks Vectorize — routing must fall back to inbox
    // even when captureMode is set to 'auto-route', without error.
    const { app, created } = makeApp();
    spy.mockResolvedValue(anthropicResp('# Topic\nSome content.'));
    const svc = new CaptureService(
      app,
      () => makeDirectCfg({ mode: 'auto-route' }),
    );
    const result = await svc.run({
      kind: 'text',
      content: 'anything',
      silent: true,
    });
    expect(result.routedTo).toBe('create');
    // requestUrl called once (provider call only — no search round-trip)
    expect(spy).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
  });

  it('surfaces provider errors instead of swallowing them (no network call on bad config)', async () => {
    // The service must propagate the provider's guard errors, not eat
    // them. The provider-level guards themselves (missing OpenRouter
    // key, oversize prompt, etc.) are exhaustively tested in
    // capture-provider.test.ts; this single propagation test proves the
    // orchestrator surfaces them and short-circuits before any network.
    const { app } = makeApp();
    const svc = new CaptureService(
      app,
      () => makeDirectCfg({ anthropicApiKey: '' }),
    );
    await expect(
      svc.run({ kind: 'text', content: 'hello', silent: true }),
    ).rejects.toThrow('No Anthropic API key');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('CaptureService.run() — worker mode', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    spy = vi.spyOn(obsidian, 'requestUrl');
  });

  it('posts to the Worker /capture endpoint and creates the note', async () => {
    const { app, created } = makeApp();
    spy.mockResolvedValue(workerResp('# Worker Note\nContent.', 'Worker Note'));
    const svc = new CaptureService(app, () => ({
      connectionMode: 'worker',
      workerUrl: 'https://w.example',
      workerToken: 'tok',
      provider: 'anthropic',
      anthropicApiKey: '',
      openrouterApiKey: '',
      defaultModel: 'claude-sonnet-4-6',
      openrouterModel: 'anthropic/claude-sonnet-4-6',
      captureFolder: 'Skald/Captures',
      promptPath: '',
      mode: 'inbox',
    }));
    const result = await svc.run({
      kind: 'text',
      content: 'something',
      silent: true,
    });
    expect(result.routedTo).toBe('create');
    expect(created[0].body).toBe('# Worker Note\nContent.');
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect((call.url as string).endsWith('/capture')).toBe(true);
  });
  // The missing-workerUrl guard is a capture-provider.ts contract (tested
  // in capture-provider.test.ts "workerCapture throws when workerUrl is
  // empty"); the service's error-propagation behavior is covered by the
  // direct-mode propagation test above, so it isn't re-echoed here.
});
