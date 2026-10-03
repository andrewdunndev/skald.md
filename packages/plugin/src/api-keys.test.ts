import { describe, expect, it } from 'vitest';
import { keyForProvider, resolveApiKeys } from './api-keys';

const store = new Map([
  ['a', ' sk-ant '],
  ['o', 'sk-or'],
  ['x', 'sk-oai'],
]);
const reader = { getSecret: (id: string) => store.get(id) ?? null };

describe('resolveApiKeys', () => {
  it('reads each provider key from its named secret, trimmed', () => {
    expect(
      resolveApiKeys(reader, { anthropicKeySecret: 'a', openrouterKeySecret: 'o', openaiKeySecret: 'x' }),
    ).toEqual({ anthropicApiKey: 'sk-ant', openrouterApiKey: 'sk-or', openaiApiKey: 'sk-oai' });
  });

  it('resolves an unnamed or missing secret to an empty key', () => {
    expect(
      resolveApiKeys(reader, { anthropicKeySecret: '', openrouterKeySecret: 'gone', openaiKeySecret: '' }),
    ).toEqual({ anthropicApiKey: '', openrouterApiKey: '', openaiApiKey: '' });
  });
});

describe('keyForProvider', () => {
  const keys = { anthropicApiKey: 'ant', openrouterApiKey: 'or', openaiApiKey: 'oai' };
  it.each([
    ['anthropic', 'ant'],
    ['openrouter', 'or'],
    ['openai', 'oai'],
  ] as const)('returns the %s key', (provider, key) => {
    expect(keyForProvider(provider, keys)).toBe(key);
  });
});
