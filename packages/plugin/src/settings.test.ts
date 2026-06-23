/**
 * Tests for normalizeSettings (settings.ts) — the data.json trust boundary.
 *
 * data.json is operator-editable AND Obsidian-Sync delivered, so the persisted
 * blob is UNTRUSTED. loadSettings runs every loaded object through
 * normalizeSettings before it reaches the rest of the plugin. These tests feed
 * hostile / malformed data.json shapes and assert the normalized output is
 * safe:
 *
 *   - unknown `provider`         → coerced to the default ('anthropic'), so it
 *     can never reach the exhaustive provider switches (assertNever).
 *   - non-string scalar fields   → dropped, replaced by DEFAULT_SETTINGS.
 *   - cleartext non-loopback     → openaiBaseUrl clamped to '' so prompts +
 *     openaiBaseUrl                  the API key cannot be sent over the wire.
 *   - missing keys               → filled from DEFAULT_SETTINGS.
 *   - null / non-object input    → full DEFAULT_SETTINGS.
 *   - valid settings             → round-trip unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  parseDomainList,
  DEFAULT_SETTINGS,
  type SkaldSettings,
} from './settings';
import { normalizeSettings } from './settings-normalize';
import { providerCapabilities } from './provider-capabilities';

describe('normalizeSettings: provider coercion', () => {
  it('coerces an unknown provider string to the default', () => {
    const out = normalizeSettings({ provider: 'evil-provider' });
    expect(out.provider).toBe('anthropic');
  });

  it('coerces a non-string provider (object) to the default', () => {
    const out = normalizeSettings({ provider: { sneaky: true } });
    expect(out.provider).toBe('anthropic');
  });

  it('keeps every valid provider value unchanged', () => {
    for (const p of ['anthropic', 'openrouter', 'openai'] as const) {
      expect(normalizeSettings({ provider: p }).provider).toBe(p);
    }
  });

  it('produces a provider that never trips the exhaustive capability switch', () => {
    // The whole point of the coercion: a hostile provider must resolve to a
    // value providerCapabilities() can handle without throwing via assertNever.
    const out = normalizeSettings({ provider: 'not-a-provider' });
    expect(() => providerCapabilities(out.provider)).not.toThrow();
  });
});

describe('normalizeSettings: non-string scalar fields', () => {
  it('drops a non-string anthropicApiKey and falls back to the default', () => {
    const out = normalizeSettings({ anthropicApiKey: 12345 });
    expect(out.anthropicApiKey).toBe(DEFAULT_SETTINGS.anthropicApiKey);
    expect(typeof out.anthropicApiKey).toBe('string');
  });

  it('drops a non-string model field and falls back to the default', () => {
    const out = normalizeSettings({ defaultModel: { not: 'a string' } });
    expect(out.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel);
  });

  it('drops a null folder field and falls back to the default', () => {
    const out = normalizeSettings({ chatsFolder: null });
    expect(out.chatsFolder).toBe(DEFAULT_SETTINGS.chatsFolder);
  });

  it('keeps a legitimately-empty string field as empty (not replaced)', () => {
    // logsFolder defaults to '' and an explicit '' is a valid value.
    const out = normalizeSettings({ logsFolder: '' });
    expect(out.logsFolder).toBe('');
  });

  it('drops a non-boolean memoryEnabled and falls back to the default', () => {
    const out = normalizeSettings({ memoryEnabled: 'yes' });
    expect(out.memoryEnabled).toBe(DEFAULT_SETTINGS.memoryEnabled);
    expect(typeof out.memoryEnabled).toBe('boolean');
  });

  it('keeps a valid boolean override that differs from the default', () => {
    expect(normalizeSettings({ memoryEnabled: false }).memoryEnabled).toBe(false);
    expect(normalizeSettings({ thinkingEnabled: true }).thinkingEnabled).toBe(true);
    expect(normalizeSettings({ compactToolResults: false }).compactToolResults).toBe(false);
  });
});

describe('normalizeSettings: openaiBaseUrl clamp (https enforcement)', () => {
  it('clamps a cleartext non-loopback http URL to empty', () => {
    const out = normalizeSettings({
      provider: 'openai',
      openaiBaseUrl: 'http://evil.example.com/v1',
    });
    expect(out.openaiBaseUrl).toBe('');
  });

  it('clamps an unparseable base URL to empty', () => {
    const out = normalizeSettings({ openaiBaseUrl: 'not a url at all' });
    expect(out.openaiBaseUrl).toBe('');
  });

  it('clamps a non-https/http scheme (ftp) to empty', () => {
    const out = normalizeSettings({ openaiBaseUrl: 'ftp://host/v1' });
    expect(out.openaiBaseUrl).toBe('');
  });

  it('keeps a valid https base URL unchanged', () => {
    const url = 'https://llm.dunn.dev/v1';
    expect(normalizeSettings({ openaiBaseUrl: url }).openaiBaseUrl).toBe(url);
  });

  it('keeps a loopback http base URL (traffic never leaves the machine)', () => {
    const url = 'http://localhost:11434/v1';
    expect(normalizeSettings({ openaiBaseUrl: url }).openaiBaseUrl).toBe(url);
  });

  it('drops a non-string openaiBaseUrl to empty', () => {
    expect(normalizeSettings({ openaiBaseUrl: 9000 }).openaiBaseUrl).toBe('');
  });
});

describe('normalizeSettings: missing keys + defaults merge', () => {
  it('fills every missing key from DEFAULT_SETTINGS', () => {
    const out = normalizeSettings({ anthropicApiKey: 'sk-ant-keepme' });
    // The provided key survives…
    expect(out.anthropicApiKey).toBe('sk-ant-keepme');
    // …and the rest is the default surface, fully populated.
    const { anthropicApiKey: _ak, ...rest } = out;
    const { anthropicApiKey: _dk, ...defRest } = DEFAULT_SETTINGS;
    void _ak;
    void _dk;
    expect(rest).toEqual(defRest);
  });

  it('returns the full DEFAULT_SETTINGS for null input', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns the full DEFAULT_SETTINGS for a non-object input', () => {
    expect(normalizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores unknown extra keys in the stored blob', () => {
    const out = normalizeSettings({ provider: 'anthropic', bogusKey: 'x' });
    expect(out).not.toHaveProperty('bogusKey');
  });
});

describe('normalizeSettings: valid settings round-trip unchanged', () => {
  it('returns an equivalent object for a fully-valid stored blob', () => {
    const valid: SkaldSettings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai',
      anthropicApiKey: 'sk-ant-xyz',
      openaiApiKey: 'oai-xyz',
      openaiBaseUrl: 'https://llm.dunn.dev/v1',
      openaiModel: 'qwen2.5-14b',
      memoryEnabled: false,
      thinkingEnabled: true,
    };
    expect(normalizeSettings(valid)).toEqual(valid);
  });

  it('does not mutate the input object', () => {
    const input = { provider: 'evil', anthropicApiKey: 7 } as unknown;
    const snapshot = JSON.stringify(input);
    normalizeSettings(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('parseDomainList', () => {
  it('splits on newlines and commas, trimming each entry', () => {
    expect(parseDomainList('a.com\nb.com, c.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });
  it('drops empty entries and surrounding whitespace', () => {
    expect(parseDomainList('  a.com  ,\n , \n b.com ')).toEqual(['a.com', 'b.com']);
  });
  it('de-duplicates', () => {
    expect(parseDomainList('a.com\na.com\nb.com\na.com')).toEqual(['a.com', 'b.com']);
  });
  it('returns [] for empty / whitespace-only input', () => {
    expect(parseDomainList('')).toEqual([]);
    expect(parseDomainList('  \n , \n ')).toEqual([]);
  });
});

describe('DEFAULT_SETTINGS — web-tools security posture', () => {
  it('ships web tools OFF by default (exfil channel closed)', () => {
    expect(DEFAULT_SETTINGS.webToolsEnabled).toBe(false);
  });
  it('ships an empty allow-list by default', () => {
    expect(DEFAULT_SETTINGS.webFetchAllowedDomains).toEqual([]);
  });
});

describe('normalizeSettings: web-tools fields (data.json trust boundary)', () => {
  it('preserves a real enabled + allow-list (does not reset on load)', () => {
    const out = normalizeSettings({
      webToolsEnabled: true,
      webFetchAllowedDomains: ['a.com', 'b.com'],
    });
    expect(out.webToolsEnabled).toBe(true);
    expect(out.webFetchAllowedDomains).toEqual(['a.com', 'b.com']);
  });
  it('coerces a non-boolean webToolsEnabled to the safe default (off)', () => {
    expect(normalizeSettings({ webToolsEnabled: 'yes' }).webToolsEnabled).toBe(false);
  });
  it('drops non-array / non-string domain values', () => {
    expect(normalizeSettings({ webFetchAllowedDomains: 'a.com' }).webFetchAllowedDomains).toEqual([]);
    expect(
      normalizeSettings({ webFetchAllowedDomains: ['ok.com', 5, null, 'two.com'] }).webFetchAllowedDomains,
    ).toEqual(['ok.com', 'two.com']);
  });
});
