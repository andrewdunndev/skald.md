/**
 * Auth-helper tests. Each test asserts the EXACT shape returned by
 * the helper (status code + reason string) so a regression that
 * swaps "bad token" for "invalid token" (and breaks downstream
 * error log scraping) fails loudly.
 *
 * Uses a real TokenRegistry so the auth path tests the integration
 * of registry + helper, not a stubbed one.
 */
import { describe, expect, it } from 'vitest';
import { TokenRegistry } from '../auth';
import { authBearer, authBearerOrQuery, authSubprotocol } from './auth-helpers';

function registryWith(token: string, scopes: string[] = ['chat']) {
  return new TokenRegistry({
    SKALD_TOKENS: JSON.stringify([
      { label: 'plugin', token, scopes },
    ]),
  });
}

describe('authBearer', () => {
  it('returns ok=true with the matched record on a valid Bearer header', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(authBearer(req, r)).toEqual({
      ok: true,
      result: { label: 'plugin', scopes: ['chat'] },
    });
  });

  it('rejects with status 401 + "missing bearer" when no Authorization header', () => {
    const r = registryWith('x');
    const req = new Request('https://w.example');
    expect(authBearer(req, r)).toEqual({
      ok: false,
      reason: 'missing bearer',
      status: 401,
    });
  });

  it('rejects with "missing bearer" when header lacks the Bearer prefix', () => {
    const r = registryWith('x');
    const req = new Request('https://w.example', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(authBearer(req, r)).toEqual({
      ok: false,
      reason: 'missing bearer',
      status: 401,
    });
  });

  it('rejects with status 401 + "bad token" when Bearer token does not match', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(authBearer(req, r)).toEqual({
      ok: false,
      reason: 'bad token',
      status: 401,
    });
  });

  it('trims surrounding whitespace from the bearer candidate', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example', {
      headers: { Authorization: 'Bearer   valid-token  ' },
    });
    expect(authBearer(req, r).ok).toBe(true);
  });
});

describe('authBearerOrQuery', () => {
  it('accepts a valid Bearer header (preferred path)', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/admin', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(authBearerOrQuery(req, r)).toEqual({
      ok: true,
      result: { label: 'plugin', scopes: ['chat'] },
    });
  });

  it('accepts ?token=... when no Bearer header present', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/admin?token=valid-token');
    expect(authBearerOrQuery(req, r)).toEqual({
      ok: true,
      result: { label: 'plugin', scopes: ['chat'] },
    });
  });

  it('falls through to the bearer error when neither header nor query token are present', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/admin');
    expect(authBearerOrQuery(req, r)).toEqual({
      ok: false,
      reason: 'missing bearer',
      status: 401,
    });
  });

  it('rejects with "bad token" when ?token= names an unknown candidate', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/admin?token=wrong');
    expect(authBearerOrQuery(req, r)).toEqual({
      ok: false,
      reason: 'bad token',
      status: 401,
    });
  });

  it('prefers bearer over query when both are present (does not double-check)', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/admin?token=wrong', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(authBearerOrQuery(req, r).ok).toBe(true);
  });

  it('trims whitespace from the query token', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/admin?token=%20valid-token%20');
    expect(authBearerOrQuery(req, r).ok).toBe(true);
  });
});

describe('authSubprotocol', () => {
  it('accepts a valid token in the Sec-WebSocket-Protocol header', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/', {
      headers: { 'Sec-WebSocket-Protocol': 'valid-token' },
    });
    expect(authSubprotocol(req, r)).toEqual({
      ok: true,
      result: { label: 'plugin', scopes: ['chat'] },
    });
  });

  it('uses ONLY the first comma-separated subprotocol value as the candidate', () => {
    // WS clients can list multiple protocols; our convention is
    // token-first. Subsequent values are ignored.
    const r = registryWith('first-token');
    const req = new Request('https://w.example/', {
      headers: {
        'Sec-WebSocket-Protocol': 'first-token, other-thing',
      },
    });
    expect(authSubprotocol(req, r).ok).toBe(true);
  });

  it('rejects with "missing protocol" when no subprotocol header present', () => {
    const r = registryWith('x');
    const req = new Request('https://w.example/');
    expect(authSubprotocol(req, r)).toEqual({
      ok: false,
      reason: 'missing protocol',
      status: 401,
    });
  });

  it('rejects with "bad token" when the first subprotocol does not match', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/', {
      headers: { 'Sec-WebSocket-Protocol': 'wrong-token' },
    });
    expect(authSubprotocol(req, r)).toEqual({
      ok: false,
      reason: 'bad token',
      status: 401,
    });
  });

  it('trims whitespace from each subprotocol entry', () => {
    const r = registryWith('valid-token');
    const req = new Request('https://w.example/', {
      headers: { 'Sec-WebSocket-Protocol': '  valid-token  , other' },
    });
    expect(authSubprotocol(req, r).ok).toBe(true);
  });
});
