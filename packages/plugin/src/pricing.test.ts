import { describe, expect, it } from 'vitest';
import {
  estimateTurnCost,
  formatCostUSD,
  formatTurnStatus,
  formatUsageFooter,
  formatSessionFooter,
  sumUsage,
  MODEL_PRICING,
  lookupPricing,
} from './pricing';

describe('estimateTurnCost', () => {
  it('computes the basic input + output cost for a known model', () => {
    // Sonnet 4.6: $3/M input, $15/M output.
    // 1M in + 1M out = $3 + $15 = $18.
    const cost = estimateTurnCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(18, 3);
  });

  it('applies the cache_read rate when usage has cache_read_input_tokens', () => {
    // 1M cache_read at $0.30/M = $0.30
    const cost = estimateTurnCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.3, 3);
  });

  it('applies the 1-hour cache_write rate (2x base) for cache_creation_input_tokens', () => {
    // skald writes its prefix with a 1-hour TTL: write = 2x base
    // input. Sonnet base is $3/M, so 1M cache_write = $6.
    const cost = estimateTurnCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(6, 3);
  });

  it('returns 0 for an unknown model', () => {
    const cost = estimateTurnCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'unknown-model-xyz',
    );
    expect(cost).toBe(0);
  });

  it('strips OpenRouter namespace when looking up pricing', () => {
    const cost = estimateTurnCost(
      { input_tokens: 1_000_000, output_tokens: 0 },
      'anthropic/claude-sonnet-4-6',
    );
    // Same as bare claude-sonnet-4-6 input rate: $3
    expect(cost).toBeCloseTo(3, 3);
  });

  it('handles small per-turn token counts (typical real usage)', () => {
    // 500 in + 1500 out on Sonnet:
    // (500 * 3 + 1500 * 15) / 1M = (1500 + 22500) / 1M = 0.024
    const cost = estimateTurnCost(
      { input_tokens: 500, output_tokens: 1500 },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(0.024, 6);
  });
});

describe('formatCostUSD', () => {
  // One row per precision band. The exact-string column pins both the
  // decimal count AND the rounding for each range; a regression in any
  // band's threshold fails its row.
  it.each([
    ['zero', 0, '$0'],
    ['below 1 cent → 4 decimals', 0.0024, '$0.0024'],
    ['below $1 → 3 decimals', 0.234, '$0.234'],
    ['above $1 → 2 decimals (rounds)', 12.345, '$12.35'],
  ])('%s', (_label, input, expected) => {
    expect(formatCostUSD(input)).toBe(expected);
  });
});

describe('sumUsage', () => {
  it('adds undefined fields as zero', () => {
    const a = { input_tokens: 100, output_tokens: 200 };
    const b = { input_tokens: 50, output_tokens: 75 };
    expect(sumUsage(a, b)).toEqual({
      input_tokens: 150,
      output_tokens: 275,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('sums cache fields when present on one side', () => {
    const a = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 200 };
    const b = { input_tokens: 0, output_tokens: 0 };
    expect(sumUsage(a, b).cache_read_input_tokens).toBe(200);
  });

  it('sums cache fields on both sides', () => {
    const a = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
    };
    const b = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    };
    const out = sumUsage(a, b);
    expect(out.cache_read_input_tokens).toBe(250);
    expect(out.cache_creation_input_tokens).toBe(125);
  });
});

describe('MODEL_PRICING table', () => {
  it('encodes the per-million input/output rates that drive every cost figure', () => {
    // These dollar values are the source of truth for the footer + saved
    // estimated_cost_usd; a typo here silently mis-bills every chat.
    expect(MODEL_PRICING['claude-sonnet-4-6']).toMatchObject({ input: 3, output: 15 });
    // Opus 4.8 and 4.7 are both $5/$25 per Anthropic pricing page
    // (verified 2026-06-17). Opus is still more expensive than Sonnet —
    // ordering is a sanity guard against a copy/paste swap between rows.
    expect(MODEL_PRICING['claude-opus-4-8'].input).toBeGreaterThan(
      MODEL_PRICING['claude-sonnet-4-6'].input,
    );
    expect(MODEL_PRICING['claude-haiku-4-5'].input).toBeLessThan(
      MODEL_PRICING['claude-sonnet-4-6'].input,
    );
  });

  it('opus-4-8 is priced (input > 0) so the cost footer is never $0', () => {
    // An unpriced model silently shows $0; this guards the default model.
    const p = MODEL_PRICING['claude-opus-4-8'];
    expect(p).toBeDefined();
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(0);
    // Verified: $5/M input, $25/M output (Anthropic models page, 2026-06-17).
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
  });

  it('prices Fable 5.2 at 8/40 with the 1-hour write and 0.025x read rates', () => {
    expect(MODEL_PRICING['claude-fable-5-2']).toEqual({
      input: 8,
      output: 40,
      cacheRead: 0.2,
      cacheWrite: 16,
    });
  });

  it('prices the corrected Fable 5.1, Sonnet 5.5 and Sonnet 5 rows', () => {
    expect(MODEL_PRICING['claude-fable-5-1']).toEqual({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite: 20,
    });
    expect(MODEL_PRICING['claude-sonnet-5-5']).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 4,
    });
    expect(MODEL_PRICING['claude-sonnet-5']).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 4,
    });
  });

  it('estimates a Fable 5.2 turn including cache reads and writes', () => {
    // 100k in * 8 + 10k out * 40 + 1M read * 0.2 + 50k write * 16
    // = 800000 + 400000 + 200000 + 800000 = 2200000 -> $2.20
    const cost = estimateTurnCost(
      {
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 50_000,
      },
      'claude-fable-5-2',
    );
    expect(cost).toBeCloseTo(2.2, 6);
  });
});

describe('formatUsageFooter', () => {
  it('formats token counts in k and includes cost for known model', () => {
    const usage = { input_tokens: 12400, output_tokens: 300 };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    // Compact one-line form: "12.4k ↑ 0.3k ↓ · $..."
    expect(out).toContain('12.4k ↑');
    expect(out).toContain('0.3k ↓');
    expect(out).toContain('$');
  });

  it('says nothing about cost for an unpriced model on the OpenAI-compatible provider', () => {
    const out = formatUsageFooter({ input_tokens: 1000, output_tokens: 500 }, 'llama3', 'openai');
    expect(out).not.toContain('cost unknown');
  });

  it('keeps cost unknown for an unpriced model on OpenRouter', () => {
    const out = formatUsageFooter({ input_tokens: 1000, output_tokens: 500 }, 'x/unknown', 'openrouter');
    expect(out).toContain('cost unknown');
  });

  it('says cost unknown for an unpriced model', () => {
    const usage = { input_tokens: 1000, output_tokens: 500 };
    const out = formatUsageFooter(usage, 'unknown-model');
    expect(out).toContain('1.0k ↑');
    expect(out).toContain('0.5k ↓');
    expect(out).toContain('cost unknown');
    expect(out).not.toContain('$');
  });

  it('does not say cost unknown for a priced model with zero usage', () => {
    const out = formatUsageFooter({ input_tokens: 0, output_tokens: 0 }, 'claude-sonnet-4-6');
    expect(out).not.toContain('cost unknown');
  });

  it('handles zero usage gracefully', () => {
    const out = formatUsageFooter({ input_tokens: 0, output_tokens: 0 }, 'claude-sonnet-4-6');
    expect(out).toContain('0.0k ↑');
    expect(out).toContain('0.0k ↓');
  });

  it('shows cached token count inline when cache_read_input_tokens > 0', () => {
    const usage = {
      input_tokens: 2100,
      output_tokens: 300,
      cache_read_input_tokens: 10300,
    };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    // Compact one-line form: "2.1k+10.3kc ↑ 0.3k ↓ · $..." ("c" = cached read).
    expect(out).toContain('2.1k+10.3kc ↑');
    expect(out).toContain('0.3k ↓');
  });

  it('omits cached annotation when cache_read_input_tokens is 0 or absent', () => {
    const usage = { input_tokens: 1000, output_tokens: 200 };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    expect(out).not.toContain('cached');
  });

  it('shows cache WRITE with +Nkw when cache_creation_input_tokens > 0', () => {
    const usage = {
      input_tokens: 800,
      output_tokens: 200,
      cache_creation_input_tokens: 10900,
    };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    // "+Nkw" surfaces a cache (re)write so repeated writes (= busting) are visible.
    expect(out).toContain('+10.9kw');
    expect(out).not.toContain('kc'); // no read part this turn
  });
});

describe('formatSessionFooter', () => {
  // 100k in + 100k out on Sonnet = $0.3 + $1.5 = $1.80 chat cost.
  const usage = { input_tokens: 100_000, output_tokens: 100_000 };

  it('appends the session cumulative when there is prior spend', () => {
    const out = formatSessionFooter(usage, 'claude-sonnet-4-6', 1.0);
    // chat $1.80, session = prior $1.00 + $1.80 = $2.80
    expect(out).toContain('session: $2.80');
    // The per-chat footer (with cost) is still present.
    expect(out).toContain('$1.80');
  });

  it('omits the session figure on the first chat (no prior spend)', () => {
    const out = formatSessionFooter(usage, 'claude-sonnet-4-6', 0);
    expect(out).not.toContain('session:');
    expect(out).toContain('$1.80');
  });

  it('falls back to the plain footer for an unknown (zero-cost) model', () => {
    const out = formatSessionFooter(usage, 'unknown-model', 5);
    expect(out).not.toContain('session:');
    expect(out).not.toContain('$');
  });
});

describe('formatTurnStatus', () => {
  it('formats a basic turn with token counts only (no dollars)', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 100, output_tokens: 200 },
      model: 'unknown',
      stopReason: 'end_turn',
    });
    expect(out).toBe('Connected · last turn: 100 in / 200 out');
    expect(out).not.toContain('$');
  });

  it('does NOT include dollar amounts even for known models', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 500, output_tokens: 1500 },
      model: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
    });
    expect(out).not.toContain('$');
    expect(out).toContain('500 in / 1500 out');
  });

  it('annotates a non-end_turn stop reason', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'unknown',
      stopReason: 'cancelled',
    });
    expect(out).toContain('cancelled');
  });

  it('annotates openrouter routes', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'unknown',
      stopReason: 'end_turn',
      provider: 'openrouter',
    });
    expect(out).toContain('openrouter');
  });

  it('surfaces cache_read_input_tokens', () => {
    const out = formatTurnStatus({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5000,
      },
      model: 'unknown',
      stopReason: 'end_turn',
    });
    expect(out).toContain('cache hit 5000');
    expect(out).not.toContain('$');
  });
});

describe('default models', () => {
  it('are priced and offered in the model list', async () => {
    const { DEFAULT_SETTINGS } = await import('./settings');
    const { ANTHROPIC_MODELS } = await import('./settings/provider');
    expect(DEFAULT_SETTINGS.defaultModel).toBe('claude-sonnet-5-5');
    expect(MODEL_PRICING[DEFAULT_SETTINGS.defaultModel]).toBeDefined();
    expect(ANTHROPIC_MODELS.map((m) => m.id)).toContain(DEFAULT_SETTINGS.defaultModel);
    expect(DEFAULT_SETTINGS.openrouterModel).toBe(
      `anthropic/${DEFAULT_SETTINGS.defaultModel.replace(/-(\d)-(\d)$/, "-$1.$2")}`,
    );
  });
});

describe('lookupPricing normalization', () => {
  const base = MODEL_PRICING['claude-sonnet-5-5'];

  it.each([
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-sonnet-5.5:batch',
    'anthropic/claude-sonnet-5.5-20261001',
    'anthropic/claude-sonnet-5-5:thinking',
  ])('prices %s as claude-sonnet-5-5', (id) => {
    expect(base).toBeDefined();
    expect(lookupPricing(id)).toBe(base);
  });

  it('prices a dotted OpenRouter haiku id', () => {
    expect(lookupPricing('anthropic/claude-haiku-4.5')).toBe(MODEL_PRICING['claude-haiku-4-5']);
  });

  it('keeps claude-sonnet-5 distinct from claude-sonnet-5-5', () => {
    expect(lookupPricing('anthropic/claude-sonnet-5')).toBe(MODEL_PRICING['claude-sonnet-5']);
    expect(lookupPricing('anthropic/claude-sonnet-5')).not.toBe(MODEL_PRICING['claude-sonnet-5-5']);
  });

  it.each([
    ['claude-fable-5.1', 'claude-fable-5-1'],
    ['claude-fable-5-1', 'claude-fable-5-1'],
    ['anthropic/claude-fable-5.2', 'claude-fable-5-2'],
    ['anthropic/claude-fable-5-2', 'claude-fable-5-2'],
  ])('prices %s as %s', (id, key) => {
    expect(lookupPricing(id)).toBe(MODEL_PRICING[key]);
  });

  it('keeps fable 5.1 and 5.2 as distinct rows', () => {
    expect(MODEL_PRICING['claude-fable-5-1']).not.toBe(MODEL_PRICING['claude-fable-5-2']);
    expect(lookupPricing('claude-fable-5.1')).not.toBe(lookupPricing('claude-fable-5.2'));
  });

  it('returns null for an unknown id', () => {
    expect(lookupPricing('anthropic/claude-nope-9.9')).toBeNull();
  });
});
