/**
 * Tests for the OpenAI base-url https-enforcement inside utilityComplete
 * (utility-call.ts) — defense-in-depth for the data.json trust boundary.
 *
 * loadSettings clamps an insecure openaiBaseUrl, but the rule must ALSO hold
 * at the dispatch point so prompts (vault content) + the API key can never be
 * sent over a cleartext non-loopback URL no matter which path supplied the
 * base URL (capture, rerank, memory-upkeep). These tests assert utilityComplete
 * refuses the bad URL WITHOUT making any network request.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import { utilityComplete } from './utility-call';

type RequestUrlResponse = ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never;

const OAI_KEY = 'oai-test-key';
const OAI_MODEL = 'qwen2.5-14b';

function makeOpenaiResp(status: number, content: string): RequestUrlResponse {
  return {
    status,
    json: { choices: [{ message: { content } }] },
    text: '',
  } as RequestUrlResponse;
}

function getCall() {
  return vi.mocked(obsidian.requestUrl).mock.calls[0][0] as unknown as Record<string, unknown>;
}

describe('utilityComplete: openai base-url https enforcement (defense-in-depth)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('refuses a cleartext non-loopback base URL without dispatching', async () => {
    const spy = vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeOpenaiResp(200, 'should-not-happen'),
    );
    const res = await utilityComplete('openai', OAI_KEY, OAI_MODEL, {
      userPrompt: 'secret vault content',
      maxTokens: 100,
      baseUrl: 'http://evil.example.com/v1',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    // The request must never go out — prompts + the API key stay home.
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an unparseable base URL without dispatching', async () => {
    const spy = vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeOpenaiResp(200, 'nope'),
    );
    const res = await utilityComplete('openai', OAI_KEY, OAI_MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
      baseUrl: 'not a url',
    });
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an empty base URL without dispatching', async () => {
    const spy = vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeOpenaiResp(200, 'nope'),
    );
    const res = await utilityComplete('openai', OAI_KEY, OAI_MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
      baseUrl: '',
    });
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('allows a loopback http base URL (traffic stays on the machine)', async () => {
    const spy = vi.mocked(obsidian.requestUrl).mockResolvedValue(
      makeOpenaiResp(200, 'ok'),
    );
    const res = await utilityComplete('openai', OAI_KEY, OAI_MODEL, {
      userPrompt: 'test',
      maxTokens: 100,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getCall().url).toBe('http://localhost:11434/v1/chat/completions');
  });
});
