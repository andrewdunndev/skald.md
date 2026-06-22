/**
 * Unit tests for resolveBannerSpec — the pure decision function that
 * determines whether a setup banner should be shown and what it should say.
 * DOM rendering (maybeRenderSetupBanner) is not tested here since it requires
 * Obsidian's extended HTMLElement API.
 */
import { describe, expect, it } from 'vitest';
import { resolveBannerSpec } from './setup-banner';
import type { SetupBannerInput } from './setup-banner';

function directInput(overrides: Partial<SetupBannerInput> = {}): SetupBannerInput {
  return {
    provider: 'anthropic',
    anthropicApiKey: 'sk-ant-live',
    openrouterApiKey: '',
    openaiBaseUrl: '',
    ...overrides,
  };
}

// ── Anthropic provider ─────────────────────────────────────────────────────

describe('resolveBannerSpec: anthropic provider', () => {
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

// ── OpenRouter provider ────────────────────────────────────────────────────

describe('resolveBannerSpec: openrouter provider', () => {
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

// ── OpenAI-compatible provider ──────────────────────────────────────────────

describe('resolveBannerSpec: openai provider', () => {
  it('returns null when a base URL is present (key is optional)', () => {
    expect(
      resolveBannerSpec(
        directInput({ provider: 'openai', openaiBaseUrl: 'https://llm.dunn.dev/v1' }),
      ),
    ).toBeNull();
  });

  it('returns a banner when the base URL is empty', () => {
    const spec = resolveBannerSpec(directInput({ provider: 'openai', openaiBaseUrl: '' }));
    expect(spec).not.toBeNull();
    expect(spec?.title).toMatch(/endpoint/i);
  });

  it('banner detail mentions a base URL and Settings → Skald', () => {
    const spec = resolveBannerSpec(directInput({ provider: 'openai', openaiBaseUrl: '' }));
    expect(spec?.detail).toMatch(/base url/i);
    expect(spec?.detail).toContain('Settings');
    expect(spec?.detail).toContain('Skald');
  });

  it('gates on base URL, NOT on a key — empty key with a base URL shows no banner', () => {
    expect(
      resolveBannerSpec(
        directInput({
          provider: 'openai',
          anthropicApiKey: '',
          openrouterApiKey: '',
          openaiBaseUrl: 'https://llm.dunn.dev/v1',
        }),
      ),
    ).toBeNull();
  });
});
