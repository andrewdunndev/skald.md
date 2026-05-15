import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { handleIndexRoute } from './index';
import { makeRegistry } from './test-helpers';

describe('handleIndexRoute', () => {
  it('returns 401 on missing Bearer', async () => {
    const r = await handleIndexRoute(
      new Request('https://w.example/index'),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(401);
  });

  it('returns 403 when token lacks chat scope', async () => {
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        headers: { Authorization: 'Bearer tok-mcp' },
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(403);
  });

  it('returns 503 when AI binding is missing', async () => {
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      { VECTORIZE: {} as any } as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('vault-memory bindings not configured');
  });

  it('returns 503 when VECTORIZE binding is missing', async () => {
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      { AI: {} as any } as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
  });

  it('returns 405 when method is not POST', async () => {
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'GET',
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      { AI: {} as any, VECTORIZE: {} as any } as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('POST');
  });

  it('returns 400 when body is missing notes array', async () => {
    const env = {
      AI: { run: vi.fn() } as any,
      VECTORIZE: { upsert: vi.fn() } as any,
    } as Env;
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('expected { notes');
  });

  it('embeds + upserts each note (happy path)', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] });
    const env = {
      AI: { run },
      VECTORIZE: { upsert, deleteByIds: vi.fn() },
    } as unknown as Env;
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notes: [{ path: 'A.md', title: 'A', content: 'short body' }],
        }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, number>;
    expect(body.indexed_summaries).toBe(1);
    // Short note (< 1000 chars) → no section vectors.
    expect(body.indexed_sections).toBe(0);
    expect(run).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
  });

  it('rejects with 413 when batch exceeds INDEX_MAX_NOTES_PER_BATCH', async () => {
    const env = {
      AI: { run: vi.fn() } as any,
      VECTORIZE: { upsert: vi.fn() } as any,
    } as Env;
    const oversize = Array.from({ length: 201 }, (_, i) => ({
      path: `note-${i}.md`,
      title: `Note ${i}`,
      content: 'short',
    }));
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ notes: oversize }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(413);
    expect(await r.text()).toContain('too many notes in batch');
  });

  it('rejects with 413 when deletes exceeds INDEX_MAX_DELETES_PER_BATCH', async () => {
    const env = {
      AI: { run: vi.fn() } as any,
      VECTORIZE: { upsert: vi.fn(), deleteByIds: vi.fn() } as any,
    } as Env;
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notes: [],
          deletes: Array.from({ length: 501 }, (_, i) => `n-${i}.md`),
        }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(413);
    expect(await r.text()).toContain('too many deletes');
  });

  it('skips oversize notes (>50KB) but processes the rest in the same batch', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue({ data: [[0.1, 0.2]] });
    const env = {
      AI: { run },
      VECTORIZE: { upsert, deleteByIds: vi.fn() },
    } as unknown as Env;
    const oversize = 'x'.repeat(50 * 1024 + 1); // 1 byte past the cap
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notes: [
            { path: 'huge.md', title: 'huge', content: oversize },
            { path: 'fine.md', title: 'fine', content: 'short body' },
          ],
        }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, number>;
    expect(body.indexed_summaries).toBe(1);
    expect(body.skipped_oversize).toBe(1);
  });

  it('processes deletes via VECTORIZE.deleteByIds with note-summary ids', async () => {
    const deleteByIds = vi.fn().mockResolvedValue(undefined);
    const env = {
      AI: { run: vi.fn().mockResolvedValue({ data: [[0.1]] }) },
      VECTORIZE: { upsert: vi.fn(), deleteByIds },
    } as unknown as Env;
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notes: [],
          deletes: ['Old.md', 'Older.md'],
        }),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(200);
    expect(deleteByIds).toHaveBeenCalledOnce();
    expect(deleteByIds).toHaveBeenCalledWith([
      'note-summary:Old.md:0',
      'note-summary:Older.md:0',
    ]);
    const body = (await r.json()) as Record<string, number>;
    expect(body.deleted).toBe(2);
  });
});
