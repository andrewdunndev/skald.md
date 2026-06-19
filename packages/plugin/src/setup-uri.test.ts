import { describe, expect, it } from 'vitest';
import { parseSetupParams } from './setup-uri';

describe('parseSetupParams', () => {
  it('accepts a valid endpoint + token pair', () => {
    const out = parseSetupParams({
      endpoint: 'https://skald.example.workers.dev',
      token: 'abcdef123456',
    });
    expect(out).toEqual({
      ok: true,
      params: {
        endpoint: 'https://skald.example.workers.dev',
        token: 'abcdef123456',
      },
    });
  });

  it('trims whitespace from both fields before validating', () => {
    const out = parseSetupParams({
      endpoint: '  https://example.com  ',
      token: '  tok  ',
    });
    expect(out).toEqual({
      ok: true,
      params: { endpoint: 'https://example.com', token: 'tok' },
    });
  });

  it('rejects a missing endpoint', () => {
    const out = parseSetupParams({ token: 'tok' });
    expect(out).toEqual({ ok: false, reason: 'missing endpoint parameter' });
  });

  it('rejects an empty-after-trim endpoint', () => {
    const out = parseSetupParams({ endpoint: '   ', token: 'tok' });
    expect(out).toEqual({ ok: false, reason: 'missing endpoint parameter' });
  });

  it('rejects a missing token', () => {
    const out = parseSetupParams({ endpoint: 'https://example.com' });
    expect(out).toEqual({ ok: false, reason: 'missing token parameter' });
  });

  it('rejects an empty-after-trim token', () => {
    const out = parseSetupParams({
      endpoint: 'https://example.com',
      token: '   ',
    });
    expect(out).toEqual({ ok: false, reason: 'missing token parameter' });
  });

  it('rejects a non-URL endpoint', () => {
    const out = parseSetupParams({
      endpoint: 'not-a-url',
      token: 'tok',
    });
    expect(out).toEqual({ ok: false, reason: 'endpoint is not a valid URL' });
  });

  it('rejects a non-http scheme like file://', () => {
    const out = parseSetupParams({
      endpoint: 'file:///etc/passwd',
      token: 'tok',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain('scheme must be http or https');
    }
  });

  it('rejects javascript: URLs', () => {
    const out = parseSetupParams({
      endpoint: 'javascript:alert(1)',
      token: 'tok',
    });
    expect(out.ok).toBe(false);
  });

  it('accepts http:// in addition to https:// (local dev)', () => {
    const out = parseSetupParams({
      endpoint: 'http://localhost:8787',
      token: 'tok',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.params.endpoint).toBe('http://localhost:8787');
    }
  });
});
