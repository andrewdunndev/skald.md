import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { handleCaptureRoute } from './capture';
import { makeRegistry } from './test-helpers';

describe('handleCaptureRoute', () => {
  it('returns 401 on missing Bearer', async () => {
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture'),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(401);
  });

  it('returns 403 when token lacks chat scope', async () => {
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        headers: { Authorization: 'Bearer tok-empty' },
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('token lacks chat scope');
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

  it('returns 503 with Anthropic-specific message when body forces anthropic + no key configured', async () => {
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'capture this', provider: 'anthropic' }),
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toBe(
      'No Anthropic API key configured on the Worker for capture.',
    );
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

  it('falls back to openrouter when no provider in body and ANTHROPIC_API_KEY unset', async () => {
    // Default routing: empty body.provider + no ANTHROPIC_API_KEY
    // forces the openrouter branch (which is also unconfigured here).
    const r = await handleCaptureRoute(
      new Request('https://w.example/capture', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-plugin',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ prompt: 'capture this' }),
      }),
      {} as Env,
      makeRegistry(),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).toBe(
      'No OpenRouter API key configured on the Worker for capture.',
    );
  });
});
