/**
 * TokenRegistry + hasScope unit tests.
 *
 * Vacuity bar: every test asserts a concrete authenticate() outcome
 * (null vs a specific {label, scopes}) for a concrete env input.
 * No "is non-null" checks — every assertion names the exact label
 * and scope set that should come back.
 */
import { describe, expect, it } from 'vitest';
import { TokenRegistry, hasScope, type Scope } from './auth';

describe('TokenRegistry: SCRIBIAN_TOKENS (multi-token)', () => {
  it('rejects an empty registry', () => {
    const r = new TokenRegistry({});
    expect(r.hasAny()).toBe(false);
    expect(r.authenticate('anything')).toBeNull();
  });

  it('authenticates a configured chat-scope token', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'hex-token-1', scopes: ['chat'] },
      ]),
    });
    expect(r.hasAny()).toBe(true);
    expect(r.authenticate('hex-token-1')).toEqual({
      label: 'plugin',
      scopes: ['chat'],
    });
  });

  it('returns null for an unknown candidate', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'hex-token-1', scopes: ['chat'] },
      ]),
    });
    expect(r.authenticate('wrong-token')).toBeNull();
  });

  it('returns null for an empty candidate even with records present', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'hex-token-1', scopes: ['chat'] },
      ]),
    });
    expect(r.authenticate('')).toBeNull();
  });

  it('routes distinct tokens to distinct labels/scopes', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'token-a', scopes: ['chat'] },
        { label: 'reader', token: 'token-b', scopes: ['chat'] },
      ]),
    });
    expect(r.authenticate('token-a')).toEqual({
      label: 'plugin',
      scopes: ['chat'],
    });
    expect(r.authenticate('token-b')).toEqual({
      label: 'reader',
      scopes: ['chat'],
    });
  });

  it('keeps timing-safe-compare semantics (length mismatch returns null without partial leak)', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'token-a', scopes: ['chat'] },
      ]),
    });
    expect(r.authenticate('token-aa')).toBeNull();
    expect(r.authenticate('toke')).toBeNull();
  });

  it('falls back gracefully when SCRIBIAN_TOKENS is not valid JSON', () => {
    const r = new TokenRegistry({ SCRIBIAN_TOKENS: 'not-json' });
    expect(r.hasAny()).toBe(false);
  });

  it('falls back when SCRIBIAN_TOKENS is JSON but not an array', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify({ label: 'x', token: 'y', scopes: ['chat'] }),
    });
    expect(r.hasAny()).toBe(false);
  });

  it('drops malformed records but keeps valid ones', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'good', token: 'tok', scopes: ['chat'] },
        { label: 'no-token' }, // missing token + scopes
        { token: 'orphan', scopes: ['chat'] }, // missing label
        { label: 'bad-scope', token: 'tok2', scopes: ['mcp:read'] }, // now unknown scope
        { label: 'empty-token', token: '', scopes: ['chat'] }, // empty token
      ]),
    });
    expect(r.authenticate('tok')).toEqual({ label: 'good', scopes: ['chat'] });
    expect(r.authenticate('orphan')).toBeNull();
    expect(r.authenticate('tok2')).toBeNull();
    expect(r.authenticate('')).toBeNull();
  });
});

describe('TokenRegistry: SCRIBIAN_TOKEN (legacy single token)', () => {
  it('treats SCRIBIAN_TOKEN as a default record with chat scope', () => {
    const r = new TokenRegistry({ SCRIBIAN_TOKEN: 'legacy-secret' });
    expect(r.hasAny()).toBe(true);
    expect(r.authenticate('legacy-secret')).toEqual({
      label: 'default',
      scopes: ['chat'],
    });
  });

  it('does not duplicate when both SCRIBIAN_TOKENS + SCRIBIAN_TOKEN name the same token', () => {
    const env = {
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'explicit', token: 'shared', scopes: ['chat'] },
      ]),
      SCRIBIAN_TOKEN: 'shared',
    };
    const r = new TokenRegistry(env);
    // Explicit registry wins; legacy fallback is skipped on collision.
    expect(r.authenticate('shared')).toEqual({
      label: 'explicit',
      scopes: ['chat'],
    });
  });

  it('supports BOTH registry tokens AND a distinct legacy token', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'explicit', token: 'token-a', scopes: ['chat'] },
      ]),
      SCRIBIAN_TOKEN: 'legacy-b',
    });
    expect(r.authenticate('token-a')).toEqual({
      label: 'explicit',
      scopes: ['chat'],
    });
    expect(r.authenticate('legacy-b')).toEqual({
      label: 'default',
      scopes: ['chat'],
    });
  });
});

describe('TokenRegistry: tokenSummaries', () => {
  it('returns label+scopes but never the secret value', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'super-secret', scopes: ['chat'] },
      ]),
    });
    const summaries = r.tokenSummaries();
    expect(summaries).toEqual([{ label: 'plugin', scopes: ['chat'] }]);
    // The token value must not appear in the summary surface.
    expect(JSON.stringify(summaries)).not.toContain('super-secret');
  });

  it('returns empty array for an empty registry', () => {
    expect(new TokenRegistry({}).tokenSummaries()).toEqual([]);
  });

  it('returns the scopes array as a copy (mutation safe)', () => {
    const r = new TokenRegistry({
      SCRIBIAN_TOKENS: JSON.stringify([
        { label: 'plugin', token: 'x', scopes: ['chat'] },
      ]),
    });
    const summaries = r.tokenSummaries();
    summaries[0].scopes.push('chat' as Scope);
    // Mutation through the summary must not affect the registry.
    const second = r.tokenSummaries();
    expect(second[0].scopes).toEqual(['chat']);
  });
});

describe('hasScope', () => {
  it('returns true when the required scope is in the list', () => {
    expect(hasScope(['chat'], 'chat')).toBe(true);
  });

  it('returns false when the required scope is not in the list', () => {
    expect(hasScope([], 'chat')).toBe(false);
  });

  it('returns false for an empty scope list', () => {
    expect(hasScope([], 'chat')).toBe(false);
  });
});
