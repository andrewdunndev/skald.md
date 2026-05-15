import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { handleSearchRoute } from './search';
import { makeRegistry } from './test-helpers';

describe('handleSearchRoute', () => {
  it('returns 401 on missing Bearer', async () => {
    const r = await handleSearchRoute(
      new Request('https://w.example/search'),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(401);
  });

  it('returns 503 when bindings missing', async () => {
    const r = await handleSearchRoute(
      new Request('https://w.example/search', {
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
  });

  it('returns 400 on empty query', async () => {
    const r = await handleSearchRoute(
      new Request('https://w.example/search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: '   ' }),
      }),
      {
        AI: { run: vi.fn() } as any,
        VECTORIZE: { query: vi.fn() } as any,
      } as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('expected { query');
  });

  it('returns the hits[] shape from VECTORIZE.query (happy path)', async () => {
    const env = {
      AI: { run: vi.fn().mockResolvedValue({ data: [[0.5, 0.5]] }) },
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: 'note-summary:A.md:0',
              score: 0.91,
              metadata: { path: 'A.md', title: 'A' },
            },
          ],
        }),
      },
    } as unknown as Env;
    const r = await handleSearchRoute(
      new Request('https://w.example/search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'tulip', top_k: 5 }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hits: any[] };
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].path).toBe('A.md');
    expect(body.hits[0].title).toBe('A');
    expect(body.hits[0].score).toBe(0.91);
    // Privacy invariant: the Worker NEVER returns plaintext excerpts.
    // Plugin re-reads from the live vault when rendering find_related.
    expect(body.hits[0]).not.toHaveProperty('excerpt');
  });

  it('rejects with 413 when query exceeds SEARCH_MAX_QUERY_BYTES', async () => {
    const env = {
      AI: { run: vi.fn() } as any,
      VECTORIZE: { query: vi.fn() } as any,
    } as Env;
    const huge = 'a'.repeat(4 * 1024 + 1);
    const r = await handleSearchRoute(
      new Request('https://w.example/search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: huge }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(413);
    expect(await r.text()).toContain('exceeds');
  });

  it('preserves heading_path in hits when present', async () => {
    const env = {
      AI: { run: vi.fn().mockResolvedValue({ data: [[0.5]] }) },
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({
          matches: [
            {
              id: 'section:A.md:2',
              score: 0.8,
              metadata: { path: 'A.md', title: 'A', headingPath: 'H1 / H2' },
            },
          ],
        }),
      },
    } as unknown as Env;
    const r = await handleSearchRoute(
      new Request('https://w.example/search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: 'x' }),
      }),
      env,
      makeRegistry(),
    );
    const body = (await r.json()) as { hits: any[] };
    expect(body.hits[0].heading_path).toBe('H1 / H2');
  });
});
