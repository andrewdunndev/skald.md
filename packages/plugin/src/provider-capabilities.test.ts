/**
 * Tests for provider-capabilities.ts.
 *
 * providerCapabilities: exhaustive switch produces correct capability flags.
 * utilityModel: resolves provider defaults, respects settings override.
 * reasoningModel: returns the correct model for each provider.
 *
 * Note: we do NOT import settings.ts here — it transitively pulls in
 * Obsidian classes (Setting, PluginSettingTab, etc.) which require a full
 * mock. Instead we inline the minimal SkaldSettings shape needed.
 */
import { describe, expect, it } from 'vitest';
import type { Provider } from './protocol';
import {
  providerCapabilities,
  utilityModel,
  reasoningModel,
  isProvider,
} from './provider-capabilities';

// Minimal SkaldSettings stub — only the fields provider-capabilities uses.
interface MinimalSettings {
  provider: Provider;
  defaultModel: string;
  openrouterModel: string;
  openaiModel: string;
  utilityModel?: string;
}

function makeSettings(overrides: Partial<MinimalSettings> = {}): MinimalSettings {
  return {
    provider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    openrouterModel: 'anthropic/claude-sonnet-4-6',
    openaiModel: '',
    utilityModel: '',
    ...overrides,
  };
}

// ── isProvider (data.json trust-boundary guard) ───────────────────────────

describe('isProvider', () => {
  it('accepts every valid Provider value', () => {
    for (const p of ['anthropic', 'openrouter', 'openai']) {
      expect(isProvider(p)).toBe(true);
    }
  });

  it('rejects an unknown provider string', () => {
    expect(isProvider('gemini')).toBe(false);
    expect(isProvider('')).toBe(false);
    expect(isProvider('ANTHROPIC')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isProvider(undefined)).toBe(false);
    expect(isProvider(null)).toBe(false);
    expect(isProvider(42)).toBe(false);
    expect(isProvider({ provider: 'anthropic' })).toBe(false);
    expect(isProvider(['anthropic'])).toBe(false);
  });
});

// ── providerCapabilities ──────────────────────────────────────────────────

describe('providerCapabilities', () => {
  it('anthropic enables caching, thinking, and citations', () => {
    expect(providerCapabilities('anthropic')).toEqual({
      promptCaching: true,
      extendedThinking: true,
      citations: true,
    });
  });

  it('openrouter disables caching, thinking, and citations', () => {
    expect(providerCapabilities('openrouter')).toEqual({
      promptCaching: false,
      extendedThinking: false,
      citations: false,
    });
  });

  it('openai disables caching, thinking, and citations', () => {
    expect(providerCapabilities('openai')).toEqual({
      promptCaching: false,
      extendedThinking: false,
      citations: false,
    });
  });
});

// ── utilityModel ──────────────────────────────────────────────────────────

// The full provider × override matrix: a non-empty override always wins;
// an empty override falls through to the per-provider default. The default
// column differs by provider (bare vs namespaced), so a regression that
// drops the override branch OR swaps a provider default fails its row.
// Cast: our minimal stub satisfies the fields utilityModel() reads.
describe('utilityModel: provider × override matrix', () => {
  it.each([
    ['anthropic, no override → default', 'anthropic', '', 'claude-haiku-4-5'],
    ['openrouter, no override → namespaced default', 'openrouter', '', 'anthropic/claude-haiku-4-5'],
    ['anthropic, override wins', 'anthropic', 'my-local-model', 'my-local-model'],
    ['openrouter, override wins', 'openrouter', 'meta-llama/llama-3-8b', 'meta-llama/llama-3-8b'],
    ['openai, override wins', 'openai', 'qwen2.5-32b', 'qwen2.5-32b'],
  ] as const)('%s', (_label, provider, override, expected) => {
    const s = makeSettings({ provider, utilityModel: override });
    expect(utilityModel(s as never)).toBe(expected);
  });

  it('openai, no override → settings.openaiModel', () => {
    const s = makeSettings({ provider: 'openai', openaiModel: 'qwen2.5-14b', utilityModel: '' });
    expect(utilityModel(s as never)).toBe('qwen2.5-14b');
  });

  it('openai, no override and no openaiModel → empty string', () => {
    const s = makeSettings({ provider: 'openai', openaiModel: '', utilityModel: '' });
    expect(utilityModel(s as never)).toBe('');
  });
});

// ── reasoningModel ────────────────────────────────────────────────────────

describe('reasoningModel: returns configured chat model', () => {
  it('anthropic → settings.defaultModel', () => {
    const s = makeSettings({ provider: 'anthropic', defaultModel: 'claude-opus-4-8' });
    expect(reasoningModel(s as never)).toBe('claude-opus-4-8');
  });

  it('openrouter → settings.openrouterModel', () => {
    const s = makeSettings({ provider: 'openrouter', openrouterModel: 'openai/gpt-5' });
    expect(reasoningModel(s as never)).toBe('openai/gpt-5');
  });

  it('openai → settings.openaiModel', () => {
    const s = makeSettings({ provider: 'openai', openaiModel: 'qwen2.5-14b' });
    expect(reasoningModel(s as never)).toBe('qwen2.5-14b');
  });
});
