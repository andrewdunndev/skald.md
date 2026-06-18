/**
 * Tests for provider-capabilities.ts.
 *
 * providerCapabilities: exhaustive switch produces correct capability flags.
 * utilityModel: resolves provider defaults, respects settings override.
 * reasoningModel: returns the correct model for each provider.
 *
 * Note: we do NOT import settings.ts here — it transitively pulls in
 * Obsidian classes (Setting, PluginSettingTab, etc.) which require a full
 * mock. Instead we inline the minimal ScribianSettings shape needed.
 */
import { describe, expect, it } from 'vitest';
import type { Provider } from '@scribian/protocol';
import {
  providerCapabilities,
  utilityModel,
  reasoningModel,
} from './provider-capabilities';

// Minimal ScribianSettings stub — only the fields provider-capabilities uses.
interface MinimalSettings {
  provider: Provider;
  defaultModel: string;
  openrouterModel: string;
  utilityModel?: string;
}

function makeSettings(overrides: Partial<MinimalSettings> = {}): MinimalSettings {
  return {
    provider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    openrouterModel: 'anthropic/claude-sonnet-4-6',
    utilityModel: '',
    ...overrides,
  };
}

// ── providerCapabilities ──────────────────────────────────────────────────

describe('providerCapabilities: anthropic', () => {
  it('has promptCaching = true', () => {
    expect(providerCapabilities('anthropic').promptCaching).toBe(true);
  });

  it('has extendedThinking = true', () => {
    expect(providerCapabilities('anthropic').extendedThinking).toBe(true);
  });

  it('has citations = true', () => {
    expect(providerCapabilities('anthropic').citations).toBe(true);
  });
});

describe('providerCapabilities: openrouter', () => {
  it('has promptCaching = false', () => {
    expect(providerCapabilities('openrouter').promptCaching).toBe(false);
  });

  it('has extendedThinking = false', () => {
    expect(providerCapabilities('openrouter').extendedThinking).toBe(false);
  });

  it('has citations = false', () => {
    expect(providerCapabilities('openrouter').citations).toBe(false);
  });
});

// ── utilityModel ──────────────────────────────────────────────────────────

describe('utilityModel: provider defaults', () => {
  it('anthropic → claude-haiku-4-5', () => {
    const s = makeSettings({ provider: 'anthropic', utilityModel: '' });
    // Cast: our minimal stub satisfies the fields utilityModel() reads.
    expect(utilityModel(s as never)).toBe('claude-haiku-4-5');
  });

  it('openrouter → anthropic/claude-haiku-4-5', () => {
    const s = makeSettings({ provider: 'openrouter', utilityModel: '' });
    expect(utilityModel(s as never)).toBe('anthropic/claude-haiku-4-5');
  });
});

describe('utilityModel: settings override takes precedence', () => {
  it('override wins over anthropic default', () => {
    const s = makeSettings({ provider: 'anthropic', utilityModel: 'my-local-model' });
    expect(utilityModel(s as never)).toBe('my-local-model');
  });

  it('override wins over openrouter default', () => {
    const s = makeSettings({ provider: 'openrouter', utilityModel: 'meta-llama/llama-3-8b' });
    expect(utilityModel(s as never)).toBe('meta-llama/llama-3-8b');
  });

  it('empty override falls through to provider default (anthropic)', () => {
    const s = makeSettings({ provider: 'anthropic', utilityModel: '' });
    expect(utilityModel(s as never)).toBe('claude-haiku-4-5');
  });

  it('empty override falls through to provider default (openrouter)', () => {
    const s = makeSettings({ provider: 'openrouter', utilityModel: '' });
    expect(utilityModel(s as never)).toBe('anthropic/claude-haiku-4-5');
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

  it('anthropic: returns the configured defaultModel', () => {
    const s = makeSettings({ provider: 'anthropic', defaultModel: 'claude-sonnet-4-6' });
    expect(reasoningModel(s as never)).toBe('claude-sonnet-4-6');
  });

  it('openrouter: returns the configured openrouterModel', () => {
    const s = makeSettings({ provider: 'openrouter', openrouterModel: 'anthropic/claude-sonnet-4-6' });
    expect(reasoningModel(s as never)).toBe('anthropic/claude-sonnet-4-6');
  });
});
