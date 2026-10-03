/**
 * Wiring test for SkaldPlugin's API keys: constructs the plugin against a
 * fake app (secret-storage double + in-memory vault) and fake
 * loadData/saveData, then drives load, settings changes, chat, and capture.
 * Keys come only from app.secretStorage by the secret names in settings; no
 * key value may ever reach saveData.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import SkaldPlugin from './main';
import type { CaptureService } from './capture';
import { connectSession, type ConnectCallbacks } from './view/connect-session';
import { bannerInputFor, resolveBannerSpec } from './view/setup-banner';
import { renderKeySetting } from './settings/provider';
import { SecretComponent as SecretPicker } from '../../../tests/obsidian-mock';

vi.mock('./view', () => ({ SkaldView: class {}, VIEW_TYPE_SKALD: 'skald-view' }));
vi.mock('./view/system-prompt', () => ({ loadSystemPrompt: () => Promise.resolve('sys') }));
const toolCalls = vi.hoisted(() => [] as Array<{ name: string; anthropicApiKey?: string }>);
vi.mock('./tools', async (load) => ({
  ...(await load<typeof import('./tools')>()),
  executeTool: (name: string, _input: unknown, _id: string, ctx: { anthropicApiKey?: string }) => {
    toolCalls.push({ name, anthropicApiKey: ctx.anthropicApiKey });
    return Promise.resolve({ content: 'ok' });
  },
}));

const VALUES = {
  'anthropic-key': 'sk-ant-secret',
  'openrouter-key': 'sk-or-secret',
  'openai-key': 'sk-oai-secret',
};

const NAMES = {
  anthropicKeySecret: 'anthropic-key',
  openrouterKeySecret: 'openrouter-key',
  openaiKeySecret: 'openai-key',
};

function harness(initial: unknown, stored: Record<string, string> = VALUES) {
  const secrets = new Map(Object.entries(stored));
  const secretStorage = {
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, v: string) => void secrets.set(id, v),
    listSecrets: () => [...secrets.keys()],
  };
  const created: Array<{ path: string; body: string }> = [];
  const vault = {
    getAbstractFileByPath: () => null,
    create: (path: string, body: string) => {
      created.push({ path, body });
      return Promise.resolve();
    },
    createFolder: () => Promise.resolve(),
    cachedRead: () => Promise.resolve(''),
  };
  const app = { secretStorage, vault, workspace: { openLinkText: vi.fn() } };
  const plugin = new SkaldPlugin(app as never, {} as never);
  const writes: string[] = [];
  plugin.loadData = () => Promise.resolve(initial);
  plugin.saveData = (d: unknown) => {
    writes.push(JSON.stringify(d));
    return Promise.resolve();
  };
  return { plugin, app, secrets, writes, created };
}

function callbacks(status: string[]): ConnectCallbacks {
  return {
    setStatus: (text) => void status.push(text),
    handleServerMessage: () => {},
    requestRender: () => {},
    requestApproval: () => Promise.resolve(false),
    getModelValue: () => 'claude-sonnet-4-6',
    currentTurnReads: () => [],
    onDone: () => {},
    onTurnAborted: () => {},
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SkaldPlugin API keys', () => {
  it('never writes a key value to saveData through load, a secret pick, and a model switch', async () => {
    const { plugin, writes } = harness({ ...NAMES, anthropicApiKey: 'sk-ant-in-data' });
    await plugin.onload();
    expect(plugin.apiKeys().anthropicApiKey).toBe('sk-ant-secret');

    SecretPicker.instances.length = 0;
    renderKeySetting({} as HTMLElement, plugin, 'openrouterKeySecret', 'desc');
    const picker = SecretPicker.instances[0]!;
    expect(picker.value).toBe('openrouter-key');
    // The user picks an existing secret in Obsidian's picker.
    await picker.changed!('openai-key');
    expect(plugin.apiKeys().openrouterApiKey).toBe('sk-oai-secret');
    plugin.settings.defaultModel = 'claude-switched';
    await plugin.saveSettings();

    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w).not.toMatch(/sk-|ApiKey/);
      expect(Object.keys(JSON.parse(w) as object)).not.toContain('anthropicApiKey');
    }
    expect(JSON.parse(writes[1]!)).toMatchObject({
      anthropicKeySecret: 'anthropic-key',
      openrouterKeySecret: 'openai-key',
      defaultModel: 'claude-switched',
    });
  });

  it('ignores a key value in data.json and reads secret storage on every call', async () => {
    const { plugin, secrets } = harness({ ...NAMES, openaiApiKey: 'sk-oai-in-data' });
    await plugin.onload();
    expect(plugin.apiKeys()).toEqual({
      anthropicApiKey: 'sk-ant-secret',
      openrouterApiKey: 'sk-or-secret',
      openaiApiKey: 'sk-oai-secret',
    });
    secrets.set('openai-key', '  sk-oai-rotated  ');
    expect(plugin.apiKeys().openaiApiKey).toBe('sk-oai-rotated');
  });

  it('shows the setup banner when the named secret is missing on this device', async () => {
    const { plugin } = harness({ ...NAMES }, {});
    await expect(plugin.onload()).resolves.toBeUndefined();
    expect(plugin.apiKeys().anthropicApiKey).toBe('');
    expect(resolveBannerSpec(bannerInputFor(plugin))?.title).toBe('Add your API key');

    const status: string[] = [];
    const { session } = connectSession(plugin.app, plugin, callbacks(status));
    expect(status).toEqual(['No API key — add it in Settings → Skald.']);
    await session.sendUserText('hello');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the setup banner for openai when the picked secret is missing on this device', async () => {
    const { plugin } = harness(
      { ...NAMES, provider: 'openai', openaiBaseUrl: 'https://llm.example/v1' },
      { 'anthropic-key': 'sk-ant-secret' },
    );
    await plugin.onload();
    expect(resolveBannerSpec(bannerInputFor(plugin))?.title).toBe('Add your API key');
    const status: string[] = [];
    connectSession(plugin.app, plugin, callbacks(status));
    expect(status).toEqual(['No API key — add it in Settings → Skald.']);
  });

  it('shows no openai banner when no secret is picked (endpoint needs no auth)', async () => {
    const { plugin } = harness({
      ...NAMES, openaiKeySecret: '', provider: 'openai', openaiBaseUrl: 'https://llm.example/v1',
    });
    await plugin.onload();
    expect(resolveBannerSpec(bannerInputFor(plugin))).toBeNull();
  });

  it.each([
    ['anthropic', {}, 'x-api-key', 'sk-ant-secret'],
    ['openrouter', {}, 'Authorization', 'Bearer sk-or-secret'],
    ['openai', { openaiBaseUrl: 'https://llm.example/v1' }, 'Authorization', 'Bearer sk-oai-secret'],
  ] as const)('sends the %s secret-storage key on the chat path', async (provider, extra, header, value) => {
    const { plugin } = harness({ ...NAMES, provider, ...extra });
    await plugin.onload();
    expect(resolveBannerSpec(bannerInputFor(plugin))).toBeNull();

    const status: string[] = [];
    const { session } = connectSession(plugin.app, plugin, callbacks(status));
    expect(status).toEqual(['Connected']);
    await session.sendUserText('hello');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers[header]).toBe(value);
    expect(Object.values(init.headers).filter((h) => h.includes('-secret'))).toEqual([value]);
  });

  it('hands the Anthropic secret-storage key to tools for rerank', async () => {
    const { plugin } = harness({ ...NAMES });
    await plugin.onload();
    toolCalls.length = 0;
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"search_vault","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    fetchSpy.mockResolvedValueOnce(new Response(sse, { status: 200 }));

    const cbs = callbacks([]);
    const { session } = connectSession(plugin.app, plugin, {
      ...cbs,
      handleServerMessage: (m) => session.handleServer(m),
    });
    await session.sendUserText('find x');
    await vi.waitFor(() => expect(toolCalls).toHaveLength(1));
    expect(toolCalls[0]).toEqual({ name: 'search_vault', anthropicApiKey: 'sk-ant-secret' });
  });

  it('the capture link does nothing until capture is turned on', async () => {
    const handlers = new Map<string, (d: obsidian.ObsidianProtocolData) => void>();
    vi.spyOn(obsidian.Plugin.prototype, 'registerObsidianProtocolHandler').mockImplementation(
      (action, cb) => void handlers.set(action, cb as never),
    );
    const off = harness({ ...NAMES });
    await off.plugin.onload();
    const offRun = vi.spyOn(off.plugin['captureService'] as CaptureService, 'handleProtocol');
    const offLog = vi.spyOn(off.plugin['logger'], 'info');
    handlers.get('skald-capture')!({ action: 'skald-capture', payload: 'x', kind: 'evil\nline' });
    expect(off.plugin.settings.captureEnabled).toBe(false);
    expect(offRun).not.toHaveBeenCalled();
    expect(offLog).not.toHaveBeenCalled();

    const on = harness({ ...NAMES, captureEnabled: true });
    await on.plugin.onload();
    const onRun = vi.spyOn(on.plugin['captureService'] as CaptureService, 'handleProtocol')
      .mockResolvedValue();
    const onLog = vi.spyOn(on.plugin['logger'], 'info');
    handlers.get('skald-capture')!({ action: 'skald-capture', payload: 'x', kind: 'evil\nline' });
    expect(onRun).toHaveBeenCalledOnce();
    expect(onLog.mock.calls.flat().join(' ')).not.toContain('evil');
  });

  it('sends the secret-storage key on the capture path', async () => {
    const { plugin, created } = harness({ ...NAMES });
    await plugin.onload();
    const spy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
      status: 200,
      text: '',
      json: { content: [{ type: 'text', text: '# Shared\nBody.' }] },
    } as never);

    const capture = plugin['captureService'] as CaptureService;
    await capture.run({ content: 'shared text', silent: true });

    const req = spy.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(req.headers['x-api-key']).toBe('sk-ant-secret');
    expect(created).toHaveLength(1);
  });
});
