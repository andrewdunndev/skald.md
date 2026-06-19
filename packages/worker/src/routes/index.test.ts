import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { handleIndexRoute } from './index';
import { makeRegistry } from './test-helpers';

describe('handleIndexRoute', () => {
  // Auth gate: route delegates to authBearer + chat-scope check (the
  // exact 401/403 reason strings are owned by auth-helpers.test.ts).
  // 401 = no/bad bearer; 403 = authenticated but lacks chat scope.
  it('gates on bearer auth + chat scope (401 / 403)', async () => {
    const reg = makeRegistry();
    const missing = await handleIndexRoute(
      new Request('https://w.example/index'),
      {} as Env,
      reg,
    );
    expect(missing.status).toBe(401);
    const noScope = await handleIndexRoute(
      new Request('https://w.example/index', {
        headers: { Authorization: 'Bearer tok-empty' },
      }),
      {} as Env,
      reg,
    );
    expect(noScope.status).toBe(403);
  });

  // Either missing binding (AI or VECTORIZE) must 503 — the route
  // requires both for vault-memory.
  it.each([
    { name: 'AI binding missing', env: { VECTORIZE: {} as any } as Env },
    { name: 'VECTORIZE binding missing', env: { AI: {} as any } as Env },
  ])('returns 503 when $name', async ({ env }) => {
    const r = await handleIndexRoute(
      new Request('https://w.example/index', {
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toContain('vault-memory bindings not configured');
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

  // Both per-batch caps (notes > 200, deletes > 500) reject with 413
  // and a cap-specific message.
  it.each([
    {
      name: 'notes batch exceeds INDEX_MAX_NOTES_PER_BATCH',
      body: {
        notes: Array.from({ length: 201 }, (_, i) => ({
          path: `note-${i}.md`,
          title: `Note ${i}`,
          content: 'short',
        })),
      },
      message: 'too many notes in batch',
    },
    {
      name: 'deletes exceed INDEX_MAX_DELETES_PER_BATCH',
      body: { notes: [], deletes: Array.from({ length: 501 }, (_, i) => `n-${i}.md`) },
      message: 'too many deletes',
    },
  ])('rejects with 413 when $name', async ({ body, message }) => {
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
        body: JSON.stringify(body),
      }),
      env,
      makeRegistry(),
    );
    expect(r.status).toBe(413);
    expect(await r.text()).toContain(message);
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
