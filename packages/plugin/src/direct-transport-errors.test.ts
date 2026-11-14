import { describe, expect, it } from 'vitest';
import { httpErrorMessage, providerErrorDetail } from './direct-transport-errors';

describe('httpErrorMessage', () => {
  it('429 → retryable rate-limit copy, with retry-after hint when present', () => {
    const e = httpErrorMessage(429, '12');
    expect(e.retryable).toBe(true);
    expect(e.error).toContain('Rate limit reached');
    expect(e.error).toContain('retry in 12s');
  });

  it('429 without retry-after → no hint, still retryable', () => {
    const e = httpErrorMessage(429, null);
    expect(e.retryable).toBe(true);
    expect(e.error).toContain('Rate limit reached');
    expect(e.error).not.toContain('retry in');
  });

  it('401 → non-retryable, points at settings, no jargon', () => {
    const e = httpErrorMessage(401);
    expect(e.retryable).toBe(false);
    expect(e.error).toMatch(/api key/i);
    expect(e.error).toMatch(/settings/i);
  });

  it('403 → same auth copy as 401', () => {
    expect(httpErrorMessage(403)).toEqual(httpErrorMessage(401));
  });

  it('400 → non-retryable, mentions image and new chat, no body echo', () => {
    const e = httpErrorMessage(400);
    expect(e.retryable).toBe(false);
    expect(e.error).toMatch(/image/i);
    expect(e.error).toMatch(/new chat/i);
  });

  it('413 → non-retryable, size-oriented actionable copy', () => {
    const e = httpErrorMessage(413);
    expect(e.retryable).toBe(false);
    expect(e.error).toMatch(/too large/i);
    expect(e.error).toMatch(/image/i);
  });

  it('5xx → retryable, provider server-error copy', () => {
    const e = httpErrorMessage(503);
    expect(e.retryable).toBe(true);
    expect(e.error).toBe('The provider returned a server error. Try again in a moment.');
    expect(e.error).not.toContain('503');
  });

  it('unexpected status (e.g. 418) → non-retryable catch-all with the code', () => {
    const e = httpErrorMessage(418);
    expect(e.retryable).toBe(false);
    expect(e.error).toContain('418');
  });

  it('maps 402 to a billing message', () => {
    const e = httpErrorMessage(402);
    expect(e.error).toMatch(/credits|billing/i);
    expect(e.retryable).toBe(false);
  });

  it('maps 404 to a model-not-found message', () => {
    const e = httpErrorMessage(404);
    expect(e.error).toBe('Model not found. Check the model id and base URL in Settings → Skald.');
    expect(e.retryable).toBe(false);
  });

  it('appends provider detail when given', () => {
    expect(httpErrorMessage(400, null, 'invalid_request_error: bad max_tokens').error).toContain(
      '(invalid_request_error: bad max_tokens)',
    );
  });
});

describe('providerErrorDetail', () => {
  it('joins error.type and error.message', () => {
    const body = JSON.stringify({ error: { type: 'not_found_error', message: 'model: x' } });
    expect(providerErrorDetail(body)).toBe('not_found_error: model: x');
  });

  it('truncates long messages to about 200 chars', () => {
    const body = JSON.stringify({ error: { message: 'a'.repeat(500) } });
    expect(providerErrorDetail(body).length).toBeLessThanOrEqual(201);
  });

  it('reads a plain string error field (Ollama style)', () => {
    expect(providerErrorDetail('{"error":"model \\"x\\" not found"}')).toBe('model "x" not found');
  });

  it('returns empty for non-JSON or bodies without an error object', () => {
    expect(providerErrorDetail('<html>502</html>')).toBe('');
    expect(providerErrorDetail('{"ok":1}')).toBe('');
    expect(providerErrorDetail('{"error":42}')).toBe('');
  });
});
