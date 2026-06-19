import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { handleCaptureRoute } from './capture';
import { makeRegistry } from './test-helpers';

describe('handleCaptureRoute', () => {
  // Auth gate: 401 when bearer missing, 403 (+ exact reason) when
  // authenticated but lacking chat scope. Reason-string semantics for
  // 401 are owned by auth-helpers.test.ts.
  it('gates on bearer auth + chat scope (401 / 403)', async () => {
    const reg = makeRegistry();
    const missing = await handleCaptureRoute(
      new Request('https://w.example/capture'),
      {} as Env,
      reg,
    );
    expect(missing.status).toBe(401);
    const noScope = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        headers: { Authorization: 'Bearer tok-empty' },
      }),
      {} as Env,
      reg,
    );
    expect(noScope.status).toBe(403);
    expect(await noScope.text()).toBe('token lacks chat scope');
  });

  it('returns 405 + Allow:POST when method is not POST', async () => {
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        method: 'GET',
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('POST');
  });

  it('returns 400 on empty prompt (validation passthrough)', async () => {
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      { ANTHROPIC_API_KEY: 'k' } as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('expected { prompt');
  });

  // 503 names the specific provider whose key is unconfigured. Two
  // routings: body forces anthropic -> anthropic message; no provider
  // in body + no ANTHROPIC_API_KEY -> openrouter fallback message. A
  // regression that mislabels the provider (or routes to the wrong
  // default) flips one of these messages.
  it.each([
    {
      name: 'body forces anthropic',
      body: { prompt: 'capture this', provider: 'anthropic' },
      message: 'No Anthropic API key configured on the Worker for capture.',
    },
    {
      name: 'default routing falls back to openrouter (no ANTHROPIC_API_KEY)',
      body: { prompt: 'capture this' },
      message: 'No OpenRouter API key configured on the Worker for capture.',
    },
  ])('returns 503 naming the unconfigured provider: $name', async ({ body, message }) => {
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toBe(message);
  });

  it('rejects with 413 when prompt exceeds CAPTURE_MAX_PROMPT_BYTES', async () => {
    const huge = 'x'.repeat(100 * 1024 + 1);
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: huge }),
      }),
      { ANTHROPIC_API_KEY: 'k' } as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(413);
    expect(await r.text()).toContain('exceeds');
  });

});
