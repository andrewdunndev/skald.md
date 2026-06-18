import { describe, expect, it } from 'vitest';
import { httpErrorMessage } from './direct-transport-errors';

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

  it('400 → non-retryable, suggests a new chat, no body echo', () => {
    const e = httpErrorMessage(400);
    expect(e.retryable).toBe(false);
    expect(e.error).toMatch(/couldn't process/i);
  });

  it('5xx → retryable, "their end" human copy', () => {
    const e = httpErrorMessage(503);
    expect(e.retryable).toBe(true);
    expect(e.error).toMatch(/try again/i);
    expect(e.error).not.toContain('503');
  });

  it('unexpected status (e.g. 418) → non-retryable catch-all with the code', () => {
    const e = httpErrorMessage(418);
    expect(e.retryable).toBe(false);
    expect(e.error).toContain('418');
  });

  it('never echoes a raw provider body — it never receives one', () => {
    // The signature only accepts a status + retry-after header, so a
    // raw JSON body structurally cannot leak into the user-facing copy.
    for (const status of [400, 401, 403, 429, 500, 503, 418]) {
      const e = httpErrorMessage(status);
      expect(e.error).not.toContain('{');
      expect(e.error).not.toContain('"error"');
    }
  });

});
