import { describe, expect, it } from 'vitest';
import { handleAdminRoute } from './admin';
import { DO_NAME, makeDOStub, makeRegistry } from './test-helpers';

describe('handleAdminRoute', () => {
  it('returns 401 when no auth provided', async () => {
    const { env } = makeDOStub();
    const r = await handleAdminRoute(
      new Request('https://w.example/admin'),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('missing bearer');
  });

  it('accepts ?token= in addition to Bearer header (admin browser-paste)', async () => {
    const { env, received } = makeDOStub();
    const r = await handleAdminRoute(
      new Request('https://w.example/admin?token=tok-plugin'),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('returns 403 when token lacks chat scope', async () => {
    const { env } = makeDOStub();
    const r = await handleAdminRoute(
      new Request('https://w.example/admin', {
        headers: { Authorization: 'Bearer tok-empty' },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('admin page requires chat scope');
  });

  it('forwards to the DO with x-skald-admin-* metadata headers', async () => {
    const { env, received } = makeDOStub();
    await handleAdminRoute(
      new Request('https://w.example/admin', {
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(received).toHaveLength(1);
    const fwd = received[0];
    const summaries = JSON.parse(
      fwd.headers.get('x-skald-admin-token-summaries')!,
    );
    expect(summaries).toEqual([
      { label: 'plugin', scopes: ['chat'] },
      { label: 'noscope', scopes: [] },
    ]);
    const envSnap = JSON.parse(
      fwd.headers.get('x-skald-admin-env-snapshot')!,
    );
    expect(envSnap).toEqual({
      anthropic: false,
      openrouter: false,
      aigw: false,
    });
  });
});
