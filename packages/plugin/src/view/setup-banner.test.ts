/**
 * Unit tests for resolveBannerSpec — the pure decision function that
 * determines whether a setup banner should be shown and what it should say.
 * DOM rendering (maybeRenderSetupBanner) is not tested here since it requires
 * Obsidian's extended HTMLElement API.
 */
import { describe, expect, it } from 'vitest';
import { resolveBannerSpec } from './setup-banner';
import type { SetupBannerInput } from './setup-banner';

function workerInput(overrides: Partial<SetupBannerInput> = {}): SetupBannerInput {
  return {
    connectionMode: 'worker',
    workerUrl: 'https://worker.example.com',
    workerToken: 'tok-123',
    provider: 'anthropic',
    anthropicApiKey: '',
    openrouterApiKey: '',
    ...overrides,
  };
}

function directInput(overrides: Partial<SetupBannerInput> = {}): SetupBannerInput {
  return {
    connectionMode: 'direct',
    workerUrl: '',
    workerToken: '',
    provider: 'anthropic',
    anthropicApiKey: 'sk-ant-live',
    openrouterApiKey: '',
    ...overrides,
  };
}

// ── Worker mode ────────────────────────────────────────────────────────────

describe('resolveBannerSpec: worker mode', () => {
  it('returns null when both workerUrl and workerToken are set', () => {
    expect(resolveBannerSpec(workerInput())).toBeNull();
  });

  it('returns a banner (title names Worker) when workerUrl is missing', () => {
    const spec = resolveBannerSpec(workerInput({ workerUrl: '' }));
    expect(spec).not.toBeNull();
    expect(spec?.detail).toContain('Worker URL');
    expect(spec?.title).toMatch(/worker/i);
  });

  it('returns a banner when workerToken is missing', () => {
    const spec = resolveBannerSpec(workerInput({ workerToken: '' }));
    expect(spec).not.toBeNull();
    expect(spec?.detail).toContain('Worker token');
  });

  it('names both missing pieces when both are absent', () => {
    const spec = resolveBannerSpec(workerInput({ workerUrl: '', workerToken: '' }));
    expect(spec).not.toBeNull();
    expect(spec?.detail).toContain('Worker URL');
    expect(spec?.detail).toContain('Worker token');
  });
});

// ── Direct mode: Anthropic ─────────────────────────────────────────────────

describe('resolveBannerSpec: direct mode, anthropic provider', () => {
  it('returns null when Anthropic key is present', () => {
    expect(resolveBannerSpec(directInput())).toBeNull();
  });

  it('returns null when key has surrounding whitespace that trims to non-empty', () => {
    expect(resolveBannerSpec(directInput({ anthropicApiKey: '  sk-ant-test  ' }))).toBeNull();
  });

  it('returns a banner when Anthropic key is empty', () => {
    const spec = resolveBannerSpec(directInput({ anthropicApiKey: '' }));
    expect(spec).not.toBeNull();
    expect(spec?.title).toMatch(/api key/i);
  });

  it('banner detail names Anthropic and references console.anthropic.com', () => {
    const spec = resolveBannerSpec(directInput({ anthropicApiKey: '' }));
    expect(spec?.detail).toMatch(/anthropic/i);
    expect(spec?.detail).toContain('console.anthropic.com');
  });

  it('banner detail mentions Settings → Skald', () => {
    const spec = resolveBannerSpec(directInput({ anthropicApiKey: '' }));
    expect(spec?.detail).toContain('Settings');
    expect(spec?.detail).toContain('Skald');
  });
});

// ── Direct mode: OpenRouter ────────────────────────────────────────────────

describe('resolveBannerSpec: direct mode, openrouter provider', () => {
  it('returns null when OpenRouter key is present', () => {
    expect(
      resolveBannerSpec(directInput({ provider: 'openrouter', openrouterApiKey: 'sk-or-live' })),
    ).toBeNull();
  });

  it('returns a banner when OpenRouter key is empty', () => {
    const spec = resolveBannerSpec(
      directInput({ provider: 'openrouter', openrouterApiKey: '' }),
    );
    expect(spec).not.toBeNull();
    expect(spec?.title).toMatch(/api key/i);
  });

  it('banner detail names OpenRouter and references openrouter.ai', () => {
    const spec = resolveBannerSpec(
      directInput({ provider: 'openrouter', openrouterApiKey: '' }),
    );
    expect(spec?.detail).toMatch(/openrouter/i);
    expect(spec?.detail).toContain('openrouter.ai');
  });

  it('only the ACTIVE provider key matters — the other key being empty is irrelevant', () => {
    // Both directions of the provider-selection branch: the inactive
    // provider's empty key must never trigger a banner.
    expect(
      resolveBannerSpec(
        directInput({ provider: 'openrouter', anthropicApiKey: '', openrouterApiKey: 'sk-or-live' }),
      ),
    ).toBeNull();
    expect(
      resolveBannerSpec(
        directInput({ provider: 'anthropic', anthropicApiKey: 'sk-ant-x', openrouterApiKey: '' }),
      ),
    ).toBeNull();
  });
});
