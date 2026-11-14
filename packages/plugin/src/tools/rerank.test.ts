import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock obsidian before importing rerank so requestUrl is interceptable.
vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import { rerankCandidates } from './rerank';

type RequestUrlResponse = ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never;

const CANDIDATES = ['c.md: apple', 'a.md: zebra', 'b.md: mango', 'd.md: orange', 'e.md: pear', 'f.md: grape'];
const API_KEY = 'sk-ant-test';
const OR_KEY = 'or-test-key';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/messages';

function anthropicOk(text: string): RequestUrlResponse {
  return {
    status: 200,
    json: { content: [{ type: 'text', text }] },
    text: '',
  } as RequestUrlResponse;
}

describe('rerankCandidates: Anthropic provider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not send an anthropic-beta header (prompt-caching is GA)', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[0]'));

    await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 }, 'claude-haiku-4-5');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const headers = (call as { headers: Record<string, string> }).headers;
    // Sending the old beta header can silently downgrade cache behaviour;
    // 1h-TTL caching is GA and must not opt into the beta endpoint.
    expect(headers).not.toHaveProperty('anthropic-beta');
    expect(Object.values(headers).join(' ')).not.toContain('prompt-caching');
  });

  it('sends a 1-hour cache_control TTL on the rerank system block for anthropic', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[0]'));

    await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 }, 'claude-haiku-4-5');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    expect(body.system[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('uses the supplied model in the request body', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[0]'));

    await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 }, 'my-custom-model');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    expect(body.model).toBe('my-custom-model');
  });

  it('happy path: returns reranked topK candidates from Haiku response', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[5,0,2,1,3]'));

    const result = await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(CANDIDATES[5]); // f.md: grape
    expect(result[1]).toBe(CANDIDATES[0]); // c.md: apple
    expect(result[2]).toBe(CANDIDATES[2]); // b.md: mango
  });

  it('parse-failure fallback: returns original slice when Haiku returns non-array JSON', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('{"error": "oops"}'));

    const result = await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('parse-failure fallback: returns original slice when Haiku returns invalid JSON', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('not json at all'));

    const result = await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('no-API-key fallback: returns original topK slice without calling Haiku', async () => {
    const spy = vi.mocked(obsidian.requestUrl);

    const result = await rerankCandidates('query', CANDIDATES, 'anthropic', '', { topK: 3 });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('error-throw fallback: returns original slice when requestUrl throws', async () => {
    vi.mocked(obsidian.requestUrl).mockRejectedValue(new Error('network error'));

    const result = await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('non-200 status fallback: returns original slice on HTTP error', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 429,
      json: {},
      text: 'rate limited',
    } as RequestUrlResponse);

    const result = await rerankCandidates('query', CANDIDATES, 'anthropic', API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('skips rerank when candidates <= topK (no API call needed)', async () => {
    const spy = vi.mocked(obsidian.requestUrl);
    const few = ['a.md', 'b.md', 'c.md'];

    const result = await rerankCandidates('query', few, 'anthropic', API_KEY, { topK: 5 });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual(few);
  });
});

describe('rerankCandidates: OpenRouter provider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ranks results using OpenRouter (Anthropic-compat /v1/messages endpoint)', async () => {
    // OpenRouter returns an Anthropic-shaped content response on /v1/messages.
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[5,0,2,1,3]'));

    const result = await rerankCandidates('query', CANDIDATES, 'openrouter', OR_KEY, { topK: 3 }, 'anthropic/claude-haiku-4.5');

    // Must have ranked successfully (not soft-failed to plain slice).
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(CANDIDATES[5]); // f.md: grape
    expect(result[1]).toBe(CANDIDATES[0]); // c.md: apple
    expect(result[2]).toBe(CANDIDATES[2]); // b.md: mango

    // The request must have gone to the OpenRouter URL.
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    expect((call as { url: string }).url).toBe(OPENROUTER_URL);
    const headers = (call as { headers: Record<string, string> }).headers;
    expect(headers['Authorization']).toBe(`Bearer ${OR_KEY}`);
  });

  it('does NOT send cache_control on the system block for OpenRouter (promptCaching=false)', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[0]'));

    await rerankCandidates('query', CANDIDATES, 'openrouter', OR_KEY, { topK: 3 }, 'anthropic/claude-haiku-4.5');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);

    // system must be a plain string, not an array with cache_control
    expect(typeof body.system).toBe('string');
    expect(body).not.toHaveProperty('system[0].cache_control');
  });

  it('soft-fails gracefully on OpenRouter API error', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 500,
      json: { content: [] },
      text: 'internal error',
    } as RequestUrlResponse);

    const result = await rerankCandidates('query', CANDIDATES, 'openrouter', OR_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('uses the OR-specific URL (not Anthropic) when provider=openrouter', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue(anthropicOk('[0]'));

    await rerankCandidates('query', CANDIDATES, 'openrouter', OR_KEY, { topK: 1 }, 'anthropic/claude-haiku-4.5');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    expect((call as { url: string }).url).toBe(OPENROUTER_URL);
    expect((call as { url: string }).url).not.toBe(ANTHROPIC_URL);
  });
});
