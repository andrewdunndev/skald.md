/**
 * Memory-binding integration tests. Pure helpers (vectorId) get
 * direct in/out coverage; binding-aware helpers (embedDocument,
 * upsertChunks, querySimilar) test against a minimal stubbed
 * AI + Vectorize that records its inputs so we can verify the
 * dispatch shape — what the Worker actually sends to Workers AI
 * + Vectorize.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  embedDocument,
  embedQuery,
  querySimilar,
  upsertChunks,
  vectorId,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMS,
} from './index';

describe('vectorId', () => {
  // id = kind:path:chunkIx. Stable (idempotent) so an id collision is
  // an upsert overwrite, and varying any component varies the id (kind
  // separates note-summary from section at the same path).
  // id = kind:path:chunkIx. chunkIx defaults to 0; kind varies the id
  // (separates note-summary from section at the same path); same inputs
  // are idempotent so an id collision is an upsert overwrite.
  it.each([
    { path: 'Bailey.md', kind: 'note-summary', ix: undefined, id: 'note-summary:Bailey.md:0' },
    { path: 'Bailey.md', kind: 'note-summary', ix: 3, id: 'note-summary:Bailey.md:3' },
    { path: 'A.md', kind: 'section', ix: undefined, id: 'section:A.md:0' },
  ])('composes $id from kind/path/chunkIx', ({ path, kind, ix, id }) => {
    expect(vectorId(path, kind as any, ix)).toBe(id);
    expect(vectorId(path, kind as any, ix)).toBe(id); // idempotent
  });
});

describe('embedDocument / embedQuery', () => {
  it('calls AI.run with the default model + text-array shape', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }) };
    const out = await embedDocument({ AI: ai } as any, { text: 'hello' });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(ai.run).toHaveBeenCalledWith(DEFAULT_EMBEDDING_MODEL, {
      text: ['hello'],
    });
    expect(out).toEqual([0.1, 0.2, 0.3]);
  });

  it('threads a model override through to AI.run', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[1]] }) };
    await embedDocument({ AI: ai } as any, {
      text: 'x',
      model: '@cf/baai/bge-m3' as any,
    });
    expect(ai.run).toHaveBeenCalledWith('@cf/baai/bge-m3', { text: ['x'] });
  });

  // Both "no usable vector" shapes throw the named empty-embedding
  // error (downstream relies on the model name in the message).
  it.each([
    { name: 'response has no data', response: {} },
    { name: 'data[0] is an empty vector', response: { data: [[]] } },
  ])('throws empty-embedding when $name', async ({ response }) => {
    const ai = { run: vi.fn().mockResolvedValue(response) };
    await expect(
      embedDocument({ AI: ai } as any, { text: 'x' }),
    ).rejects.toThrow(`empty embedding from ${DEFAULT_EMBEDDING_MODEL}`);
  });

  it('embedQuery is identity-routed to embedDocument', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.5]] }) };
    const out = await embedQuery({ AI: ai } as any, { text: 'find this' });
    expect(out).toEqual([0.5]);
    expect(ai.run).toHaveBeenCalledWith(DEFAULT_EMBEDDING_MODEL, {
      text: ['find this'],
    });
  });
});

describe('upsertChunks', () => {
  it('no-ops on an empty vector list (avoids spurious Vectorize call)', async () => {
    const vec = { upsert: vi.fn() };
    await upsertChunks({ VECTORIZE: vec } as any, []);
    expect(vec.upsert).not.toHaveBeenCalled();
  });

  it('maps ScribianVectors to the Vectorize upsert shape, routing kind onto namespace', async () => {
    // Two chunks of different kinds in one call: proves the full
    // id/values/namespace/metadata mapping AND that namespace is driven
    // by each chunk's kind (note-summary vs section not hardcoded).
    const vec = { upsert: vi.fn().mockResolvedValue(undefined) };
    await upsertChunks({ VECTORIZE: vec } as any, [
      {
        id: 'note-summary:A.md:0',
        kind: 'note-summary',
        vector: [0.1, 0.2],
        metadata: { path: 'A.md', title: 'A', sha256: 'abc', mtime: 1 },
      },
      {
        id: 'section:A.md:1',
        kind: 'section',
        vector: [0.3],
        metadata: { path: 'A.md', title: 'A', sha256: 'abc', mtime: 1 },
      },
    ]);
    expect(vec.upsert).toHaveBeenCalledWith([
      {
        id: 'note-summary:A.md:0',
        values: [0.1, 0.2],
        namespace: 'note-summary',
        metadata: { path: 'A.md', title: 'A', sha256: 'abc', mtime: 1 },
      },
      {
        id: 'section:A.md:1',
        values: [0.3],
        namespace: 'section',
        metadata: { path: 'A.md', title: 'A', sha256: 'abc', mtime: 1 },
      },
    ]);
  });
});

describe('querySimilar', () => {
  it('embeds the query, calls Vectorize.query with topK + namespace + returnMetadata', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.7, 0.7]] }) };
    const vec = {
      query: vi.fn().mockResolvedValue({
        matches: [
          { id: 'note-summary:A.md:0', score: 0.91, metadata: { path: 'A.md' } },
        ],
      }),
    };
    const hits = await querySimilar({ AI: ai, VECTORIZE: vec } as any, {
      query: 'tulip',
      kind: 'note-summary',
      topK: 5,
    });
    expect(vec.query).toHaveBeenCalledWith([0.7, 0.7], {
      topK: 5,
      namespace: 'note-summary',
      returnMetadata: 'all',
    });
    expect(hits).toEqual([
      { id: 'note-summary:A.md:0', score: 0.91, metadata: { path: 'A.md' } },
    ]);
  });

  // Param defaulting/clamping passed to Vectorize.query: namespace
  // defaults to note-summary when kind omitted; topK defaults to 8 and
  // is capped at 20 (Vectorize guard). A regression in any default
  // changes the exact query args asserted here.
  it.each([
    { name: 'defaults namespace + topK when both omitted', args: { query: 'x' }, namespace: 'note-summary', topK: 8 },
    { name: 'caps topK at 20', args: { query: 'x', topK: 9999 }, namespace: 'note-summary', topK: 20 },
  ])('$name', async ({ args, namespace, topK }) => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.5]] }) };
    const vec = { query: vi.fn().mockResolvedValue({ matches: [] }) };
    await querySimilar({ AI: ai, VECTORIZE: vec } as any, args);
    expect(vec.query.mock.calls[0][1]).toMatchObject({ namespace, topK });
  });

  it('returns empty array when Vectorize returns no matches', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.5]] }) };
    const vec = { query: vi.fn().mockResolvedValue({ matches: [] }) };
    const out = await querySimilar({ AI: ai, VECTORIZE: vec } as any, {
      query: 'x',
    });
    expect(out).toEqual([]);
  });

  it('defaults metadata to {} when Vectorize returns matches without metadata', async () => {
    const ai = { run: vi.fn().mockResolvedValue({ data: [[0.5]] }) };
    const vec = {
      query: vi.fn().mockResolvedValue({
        matches: [{ id: 'x', score: 0.7 }],
      }),
    };
    const hits = await querySimilar({ AI: ai, VECTORIZE: vec } as any, {
      query: 'x',
    });
    expect(hits[0]).toEqual({ id: 'x', score: 0.7, metadata: {} });
  });
});

describe('constants', () => {
  it('pins the embedding dims at 768 (matches the scribian-vault index config)', () => {
    expect(EMBEDDING_DIMS).toBe(768);
  });

  it('pins the default model at bge-base-en-v1.5', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('@cf/baai/bge-base-en-v1.5');
  });
});
