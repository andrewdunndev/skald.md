/**
 * Tests for memory-upkeep.ts — provider-neutral vault-memory upkeep pass.
 *
 * Covers:
 *   1. proposeMemoryUpkeep: happy path — returns proposed body with a new fact
 *   2. proposeMemoryUpkeep: soft-fails (returns null) on API error
 *   3. proposeMemoryUpkeep: returns null when memoryEnabled=false (no API key)
 *   4. proposeMemoryUpkeep: uses resolveUtilityModel, not a hardcoded model
 *   5. proposeMemoryUpkeep: returns null when proposed matches current body
 *   6. proposeMemoryUpkeep: OpenRouter path hits OpenRouter URL
 *   7. isUpkeepDue: cadence gate
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import {
  proposeMemoryUpkeep,
  isUpkeepDue,
  UPKEEP_EVERY_N_TURNS,
} from './memory-upkeep';
import { utilityModel } from './provider-capabilities';
import type { Message } from '@scribian/protocol';

// ── helpers ───────────────────────────────────────────────────────────────────

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function makeMessages(extra: string): Message[] {
  return [
    { role: 'user', content: `My favourite colour is ${extra}.` },
    { role: 'assistant', content: 'Got it, I will remember that.' },
  ];
}

function mockAnthropicOk(body: string) {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 200,
    json: { content: [{ type: 'text', text: body }] },
    text: body,
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

function mockOpenRouterOk(body: string) {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 200,
    json: { choices: [{ message: { content: body } }] },
    text: body,
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

function mockError() {
  vi.mocked(obsidian.requestUrl).mockRejectedValue(new Error('network error'));
}

function mockNon200() {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 429,
    json: {},
    text: 'rate limited',
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

// ── isUpkeepDue ───────────────────────────────────────────────────────────────

describe('isUpkeepDue', () => {
  it('returns false before UPKEEP_EVERY_N_TURNS', () => {
    expect(isUpkeepDue(UPKEEP_EVERY_N_TURNS - 1)).toBe(false);
  });

  it('returns true at exactly UPKEEP_EVERY_N_TURNS', () => {
    expect(isUpkeepDue(UPKEEP_EVERY_N_TURNS)).toBe(true);
  });

  it('returns true beyond UPKEEP_EVERY_N_TURNS', () => {
    expect(isUpkeepDue(UPKEEP_EVERY_N_TURNS + 3)).toBe(true);
  });
});

// ── proposeMemoryUpkeep ───────────────────────────────────────────────────────

describe('proposeMemoryUpkeep: Anthropic path', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the proposed body on a successful Anthropic call', async () => {
    const proposed = 'Favourite colour: blue';
    mockAnthropicOk(proposed);

    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('blue'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBe(proposed);
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    expect((call as { url: string }).url).toBe(ANTHROPIC_MESSAGES_URL);
  });

  it('uses the model supplied by the caller (resolveUtilityModel)', async () => {
    mockAnthropicOk('some body');
    await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('red'),
      model: 'my-custom-utility-model',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    expect(body.model).toBe('my-custom-utility-model');
  });

  it('soft-fails to null on network error', async () => {
    mockError();
    const result = await proposeMemoryUpkeep({
      memoryBody: 'existing',
      messages: makeMessages('green'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBeNull();
  });

  it('soft-fails to null on non-200 response', async () => {
    mockNon200();
    const result = await proposeMemoryUpkeep({
      memoryBody: 'existing',
      messages: makeMessages('yellow'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBeNull();
  });

  it('returns null when proposed body matches current body (no change)', async () => {
    const same = 'unchanged memory note';
    mockAnthropicOk(same);
    const result = await proposeMemoryUpkeep({
      memoryBody: same,
      messages: makeMessages('orange'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBeNull();
  });
});

describe('proposeMemoryUpkeep: no API key', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns null without calling the API when apiKey is empty', async () => {
    const spy = vi.mocked(obsidian.requestUrl);
    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('purple'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: '',
    });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('proposeMemoryUpkeep: OpenRouter path', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls the OpenRouter endpoint when provider=openrouter', async () => {
    mockOpenRouterOk('Favourite colour: cyan');
    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('cyan'),
      model: 'anthropic/claude-haiku-4-5',
      provider: 'openrouter',
      apiKey: 'or-test-key',
    });

    expect(result).toBe('Favourite colour: cyan');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    expect((call as { url: string }).url).toBe(OPENROUTER_URL);
  });

  it('uses the correct model in the OpenRouter request', async () => {
    mockOpenRouterOk('updated');
    await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('teal'),
      model: 'meta-llama/llama-3-8b',
      provider: 'openrouter',
      apiKey: 'or-test-key',
    });

    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    expect(body.model).toBe('meta-llama/llama-3-8b');
  });

  it('soft-fails to null on OpenRouter error', async () => {
    mockError();
    const result = await proposeMemoryUpkeep({
      memoryBody: 'existing',
      messages: makeMessages('magenta'),
      model: 'anthropic/claude-haiku-4-5',
      provider: 'openrouter',
      apiKey: 'or-test-key',
    });
    expect(result).toBeNull();
  });
});

// ── utilityModel integration: no hardcoded model ──────────────────────────────

describe('utilityModel: memory-upkeep uses resolveUtilityModel, not a hardcoded model', () => {
  it('utilityModel for anthropic default is claude-haiku-4-5', () => {
    const s = { provider: 'anthropic' as const, defaultModel: 'claude-sonnet-4-6',
      openrouterModel: '', utilityModel: '' };
    expect(utilityModel(s as never)).toBe('claude-haiku-4-5');
  });

  it('utilityModel override is respected', () => {
    const s = { provider: 'anthropic' as const, defaultModel: 'claude-sonnet-4-6',
      openrouterModel: '', utilityModel: 'my-local-model' };
    expect(utilityModel(s as never)).toBe('my-local-model');
  });
});
