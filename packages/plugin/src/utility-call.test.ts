/**
 * Tests for utility-call.ts — shared provider-agnostic completion helper.
 *
 * Covers:
 *   (a) anthropic: uses x-api-key + anthropic-version and the Anthropic URL
 *   (b) openrouter: uses Authorization Bearer + OR-specific headers + OR URL
 *   (c) cacheSystem applies cache_control for anthropic (promptCaching=true)
 *       but NOT for openrouter (promptCaching=false)
 *   (d) system is omitted from the body when opts.system is empty/absent
 *   (e) non-2xx → ok:false with errorText set
 *   (f) content blocks are parsed and joined correctly
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import { utilityComplete } from './utility-call';

type RequestUrlResponse = ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never;

function makeResp(
  status: number,
  blocks: Array<{ type: string; text: string }>,
  rawText = '',
): RequestUrlResponse {
  return {
    status,
    json: { content: blocks },
    text: rawText,
  } as RequestUrlResponse;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/messages';
const ANT_KEY = 'sk-ant-test';
const OR_KEY = 'or-test-key';
const MODEL = 'claude-haiku-4-5';

function getCall() {
  return vi.mocked(obsidian.requestUrl).mock.calls[0][0] as Record<string, unknown>;
}

describe('utilityComplete: provider routing', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // (a) Anthropic: right URL, x-api-key, anthropic-version
  it('uses the Anthropic URL and x-api-key + anthropic-version headers', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [{ type: 'text', text: 'hello' }]),
    );
    const res = await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(true);
    const call = getCall();
    expect(call.url).toBe(ANTHROPIC_URL);
    const headers = call.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(ANT_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers).not.toHaveProperty('Authorization');
  });

  // (b) OpenRouter: right URL, Bearer auth, referer, title headers
  it('uses the OpenRouter URL and Authorization Bearer + OR-specific headers', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [{ type: 'text', text: 'ranked' }]),
    );
    const res = await utilityComplete('openrouter', OR_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(true);
    const call = getCall();
    expect(call.url).toBe(OPENROUTER_URL);
    const headers = call.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${OR_KEY}`);
    expect(headers['HTTP-Referer']).toBe('https://github.com/skald/skald');
    expect(headers['X-OpenRouter-Title']).toBe('skald');
    expect(headers).not.toHaveProperty('x-api-key');
    expect(headers).not.toHaveProperty('anthropic-version');
  });
});

describe('utilityComplete: cacheSystem behaviour', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // (c) cacheSystem applies cache_control for anthropic (promptCaching=true)
  it('sends cache_control on the system block for anthropic when cacheSystem=true', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [{ type: 'text', text: 'ok' }]),
    );
    await utilityComplete('anthropic', ANT_KEY, MODEL, {
      system: 'You are a ranker.',
      userPrompt: 'rank these',
      maxTokens: 100,
      cacheSystem: true,
    });
    const body = JSON.parse(getCall().body as string);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(body.system[0].text).toBe('You are a ranker.');
    expect(body.system[0].type).toBe('text');
  });

  // (c) cacheSystem does NOT apply cache_control for openrouter (promptCaching=false)
  it('does NOT send cache_control for openrouter even when cacheSystem=true', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [{ type: 'text', text: 'ok' }]),
    );
    await utilityComplete('openrouter', OR_KEY, MODEL, {
      system: 'You are a ranker.',
      userPrompt: 'rank these',
      maxTokens: 100,
      cacheSystem: true,
    });
    const body = JSON.parse(getCall().body as string);
    // system must be a plain string (not an array with cache_control)
    expect(typeof body.system).toBe('string');
    expect(body.system).toBe('You are a ranker.');
  });
});

describe('utilityComplete: system omission', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // (d) system omitted when opts.system is empty/absent
  it('omits the system key when opts.system is not provided', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [{ type: 'text', text: 'ok' }]),
    );
    await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'hello',
      maxTokens: 100,
    });
    const body = JSON.parse(getCall().body as string);
    expect(body).not.toHaveProperty('system');
  });

  it('omits the system key when opts.system is an empty string', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [{ type: 'text', text: 'ok' }]),
    );
    await utilityComplete('anthropic', ANT_KEY, MODEL, {
      system: '',
      userPrompt: 'hello',
      maxTokens: 100,
    });
    const body = JSON.parse(getCall().body as string);
    expect(body).not.toHaveProperty('system');
  });
});

describe('utilityComplete: error handling', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // (e) non-2xx → ok:false with errorText
  it('returns ok:false with errorText on a non-2xx response', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 429,
      json: { content: [] },
      text: 'rate limited by provider',
    } as RequestUrlResponse);
    const res = await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    expect(res.errorText).toBe('rate limited by provider');
  });

  it('returns ok:false with errorText truncated to 300 chars', async () => {
    const longError = 'x'.repeat(500);
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 500,
      json: { content: [] },
      text: longError,
    } as RequestUrlResponse);
    const res = await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(false);
    expect(res.errorText).toHaveLength(300);
  });
});

describe('utilityComplete: content parsing', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // (f) multiple text blocks are joined; non-text blocks are filtered out
  it('joins multiple text blocks with newlines', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    );
    const res = await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('first\nsecond');
  });

  it('filters out non-text content blocks', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 200,
      json: {
        content: [
          { type: 'tool_use', id: 'abc' },
          { type: 'text', text: 'hello' },
        ],
      },
      text: '',
    } as RequestUrlResponse);
    const res = await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('hello');
  });

  it('returns empty string text when content array is empty', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeResp(200, []),
    );
    const res = await utilityComplete('anthropic', ANT_KEY, MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('');
  });
});
