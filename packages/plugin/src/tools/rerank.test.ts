import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock obsidian before importing rerank so requestUrl is interceptable.
vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import { rerankCandidates } from './rerank';

const CANDIDATES = ['c.md: apple', 'a.md: zebra', 'b.md: mango', 'd.md: orange', 'e.md: pear', 'f.md: grape'];
const API_KEY = 'sk-ant-test';

describe('rerankCandidates', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: returns reranked topK candidates from Haiku response', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 200,
      json: {
        content: [{ type: 'text', text: '[5,0,2,1,3]' }],
      },
      text: '',
    } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);

    const result = await rerankCandidates('query', CANDIDATES, API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(CANDIDATES[5]); // f.md: grape
    expect(result[1]).toBe(CANDIDATES[0]); // c.md: apple
    expect(result[2]).toBe(CANDIDATES[2]); // b.md: mango
  });

  it('parse-failure fallback: returns original slice when Haiku returns non-array JSON', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 200,
      json: { content: [{ type: 'text', text: '{"error": "oops"}' }] },
      text: '',
    } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);

    const result = await rerankCandidates('query', CANDIDATES, API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('parse-failure fallback: returns original slice when Haiku returns invalid JSON', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 200,
      json: { content: [{ type: 'text', text: 'not json at all' }] },
      text: '',
    } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);

    const result = await rerankCandidates('query', CANDIDATES, API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('no-API-key fallback: returns original topK slice without calling Haiku', async () => {
    const spy = vi.mocked(obsidian.requestUrl);

    const result = await rerankCandidates('query', CANDIDATES, '', { topK: 3 });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('error-throw fallback: returns original slice when requestUrl throws', async () => {
    vi.mocked(obsidian.requestUrl).mockRejectedValue(new Error('network error'));

    const result = await rerankCandidates('query', CANDIDATES, API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('non-200 status fallback: returns original slice on HTTP error', async () => {
    vi.mocked(obsidian.requestUrl).mockResolvedValue({
      status: 429,
      json: {},
      text: 'rate limited',
    } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);

    const result = await rerankCandidates('query', CANDIDATES, API_KEY, { topK: 3 });
    expect(result).toHaveLength(3);
    expect(result).toEqual(CANDIDATES.slice(0, 3));
  });

  it('skips rerank when candidates <= topK (no API call needed)', async () => {
    const spy = vi.mocked(obsidian.requestUrl);
    const few = ['a.md', 'b.md', 'c.md'];

    const result = await rerankCandidates('query', few, API_KEY, { topK: 5 });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual(few);
  });
});
