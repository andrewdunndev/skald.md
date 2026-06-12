/**
 * Unit tests for capture-provider.ts — the low-level provider call
 * helpers used by CaptureService in both worker and direct modes.
 * requestUrl is mocked via vi.spyOn on the obsidian alias so no real
 * network I/O occurs.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as obsidian from 'obsidian';
import { CAPTURE_MAX_PROMPT_BYTES } from '@scribian/protocol';
import { workerCapture, directCapture } from './capture-provider';

// ── helpers ───────────────────────────────────────────────────────────────

/** Build a fake requestUrl response. */
function fakeResp(status: number, json: unknown): {
  status: number;
  text: string;
  json: unknown;
} {
  return { status, text: JSON.stringify(json), json };
}

/** Anthropic-shaped model response (non-streaming). */
function anthropicResp(text: string) {
  return fakeResp(200, {
    content: [{ type: 'text', text }],
  });
}

describe('workerCapture', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    spy = vi.spyOn(obsidian, 'requestUrl');
  });

  it('throws when workerUrl is empty', async () => {
    await expect(
      workerCapture({
        workerUrl: '',
        workerToken: 'tok',
        prompt: 'hello',
        kind: 'text',
      }),
    ).rejects.toThrow('Worker URL + token must be configured');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws when workerToken is empty', async () => {
    await expect(
      workerCapture({
        workerUrl: 'https://w.example',
        workerToken: '',
        prompt: 'hello',
        kind: 'text',
      }),
    ).rejects.toThrow('Worker URL + token must be configured');
  });

  it('POSTs to /capture and returns body + title', async () => {
    spy.mockResolvedValue(
      fakeResp(200, { body: '# Tulips\nRed petals.', title: 'Tulips' }),
    );
    const result = await workerCapture({
      workerUrl: 'https://w.example',
      workerToken: 'secret',
      prompt: 'some prompt',
      kind: 'text',
    });
    expect(result.body).toBe('# Tulips\nRed petals.');
    expect(result.title).toBe('Tulips');
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.url).toBe('https://w.example/capture');
    expect((call.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret',
    );
  });

  it('normalises ws:// URL to http://', async () => {
    spy.mockResolvedValue(
      fakeResp(200, { body: 'body', title: 'title' }),
    );
    await workerCapture({
      workerUrl: 'wss://w.example',
      workerToken: 'tok',
      prompt: 'p',
      kind: 'url',
    });
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect((call.url as string).startsWith('https://')).toBe(true);
  });

  it('throws on non-2xx status', async () => {
    spy.mockResolvedValue(fakeResp(503, 'service unavailable'));
    await expect(
      workerCapture({
        workerUrl: 'https://w.example',
        workerToken: 'tok',
        prompt: 'p',
        kind: 'text',
      }),
    ).rejects.toThrow('/capture returned 503');
  });

  it('throws when response body is missing', async () => {
    spy.mockResolvedValue(fakeResp(200, { title: 'x' }));
    await expect(
      workerCapture({
        workerUrl: 'https://w.example',
        workerToken: 'tok',
        prompt: 'p',
        kind: 'text',
      }),
    ).rejects.toThrow('missing body');
  });
});

describe('directCapture — Anthropic', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    spy = vi.spyOn(obsidian, 'requestUrl');
  });

  it('throws when Anthropic key is empty', async () => {
    await expect(
      directCapture({
        provider: 'anthropic',
        anthropicApiKey: '',
        openrouterApiKey: '',
        defaultModel: 'claude-sonnet-4-6',
        openrouterModel: 'anthropic/claude-sonnet-4-6',
        prompt: 'hello',
      }),
    ).rejects.toThrow('No Anthropic API key');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws when prompt exceeds CAPTURE_MAX_PROMPT_BYTES', async () => {
    const huge = 'x'.repeat(CAPTURE_MAX_PROMPT_BYTES + 1);
    await expect(
      directCapture({
        provider: 'anthropic',
        anthropicApiKey: 'sk-ant',
        openrouterApiKey: '',
        defaultModel: 'claude-sonnet-4-6',
        openrouterModel: 'anthropic/claude-sonnet-4-6',
        prompt: huge,
      }),
    ).rejects.toThrow('too large');
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls Anthropic API with x-api-key header', async () => {
    spy.mockResolvedValue(anthropicResp('# Flowers\nPretty ones.'));
    const result = await directCapture({
      provider: 'anthropic',
      anthropicApiKey: 'sk-ant-key',
      openrouterApiKey: '',
      defaultModel: 'claude-sonnet-4-6',
      openrouterModel: 'anthropic/claude-sonnet-4-6',
      prompt: 'process this',
    });
    expect(result.body).toBe('# Flowers\nPretty ones.');
    expect(result.title).toBe('Flowers');
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    const hdrs = call.headers as Record<string, string>;
    expect(hdrs['x-api-key']).toBe('sk-ant-key');
    expect(hdrs['anthropic-version']).toBe('2023-06-01');
    expect('anthropic-dangerous-direct-browser-access' in hdrs).toBe(false);
  });

  it('throws on non-2xx Anthropic response', async () => {
    spy.mockResolvedValue(fakeResp(401, { type: 'error' }));
    await expect(
      directCapture({
        provider: 'anthropic',
        anthropicApiKey: 'sk-ant',
        openrouterApiKey: '',
        defaultModel: 'claude-sonnet-4-6',
        openrouterModel: 'anthropic/claude-sonnet-4-6',
        prompt: 'p',
      }),
    ).rejects.toThrow('anthropic API returned 401');
  });

  it('throws when model returns no text content', async () => {
    spy.mockResolvedValue(fakeResp(200, { content: [] }));
    await expect(
      directCapture({
        provider: 'anthropic',
        anthropicApiKey: 'sk-ant',
        openrouterApiKey: '',
        defaultModel: 'claude-sonnet-4-6',
        openrouterModel: 'anthropic/claude-sonnet-4-6',
        prompt: 'p',
      }),
    ).rejects.toThrow('no text content');
  });
});

describe('directCapture — OpenRouter', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    spy = vi.spyOn(obsidian, 'requestUrl');
  });

  it('throws when OpenRouter key is empty', async () => {
    await expect(
      directCapture({
        provider: 'openrouter',
        anthropicApiKey: '',
        openrouterApiKey: '',
        defaultModel: 'claude-sonnet-4-6',
        openrouterModel: 'anthropic/claude-sonnet-4-6',
        prompt: 'hello',
      }),
    ).rejects.toThrow('No OpenRouter API key');
  });

  it('calls OpenRouter with Authorization Bearer header', async () => {
    spy.mockResolvedValue(anthropicResp('# OpenRouter result\nGood.'));
    const result = await directCapture({
      provider: 'openrouter',
      anthropicApiKey: '',
      openrouterApiKey: 'sk-or-key',
      defaultModel: 'claude-sonnet-4-6',
      openrouterModel: 'anthropic/claude-sonnet-4-6',
      prompt: 'process this',
    });
    expect(result.body).toBe('# OpenRouter result\nGood.');
    expect(result.title).toBe('OpenRouter result');
    const call = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.url).toBe('https://openrouter.ai/api/v1/messages');
    const hdrs = call.headers as Record<string, string>;
    expect(hdrs['Authorization']).toBe('Bearer sk-or-key');
  });
});
