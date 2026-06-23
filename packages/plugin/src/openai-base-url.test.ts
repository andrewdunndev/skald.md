import { describe, expect, it } from 'vitest';
import { isLoopbackHost, validateOpenAiBaseUrl } from './openai-base-url';

describe('isLoopbackHost', () => {
  it('recognizes localhost / 127.0.0.1 / ::1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.7.7.7')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('your-endpoint.example')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('169.254.1.1')).toBe(false);
  });
});

describe('validateOpenAiBaseUrl', () => {
  it('accepts https for any host', () => {
    expect(validateOpenAiBaseUrl('https://your-endpoint.example/v1').ok).toBe(true);
  });

  it('accepts empty input (not yet configured)', () => {
    expect(validateOpenAiBaseUrl('').ok).toBe(true);
    expect(validateOpenAiBaseUrl('   ').ok).toBe(true);
  });

  it('accepts http ONLY for loopback', () => {
    expect(validateOpenAiBaseUrl('http://localhost:11434/v1').ok).toBe(true);
    expect(validateOpenAiBaseUrl('http://127.0.0.1:8080/v1').ok).toBe(true);
  });

  it('rejects http for a remote host', () => {
    const r = validateOpenAiBaseUrl('http://your-endpoint.example/v1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/i);
  });

  it('rejects non-http(s) schemes', () => {
    expect(validateOpenAiBaseUrl('ftp://example.com').ok).toBe(false);
    expect(validateOpenAiBaseUrl('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(validateOpenAiBaseUrl('not a url').ok).toBe(false);
  });
});
