import { describe, expect, it } from 'vitest';
import {
  estimateTurnCost,
  formatCostUSD,
  formatTurnStatus,
  formatUsageFooter,
  formatSessionFooter,
  sumUsage,
  MODEL_PRICING,
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
    // scribian writes its prefix with a 1-hour TTL: write = 2x base
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
  it('shows $0 for zero', () => {
    expect(formatCostUSD(0)).toBe('$0');
  });

  it('uses 4 decimals below 1 cent', () => {
    expect(formatCostUSD(0.0024)).toBe('$0.0024');
  });

  it('uses 3 decimals below $1', () => {
    expect(formatCostUSD(0.234)).toBe('$0.234');
  });

  it('uses 2 decimals above $1', () => {
    expect(formatCostUSD(12.345)).toBe('$12.35');
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
  it('includes opus, sonnet, haiku', () => {
    expect(MODEL_PRICING['claude-opus-4-7']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
  });
});

describe('formatUsageFooter', () => {
  it('formats token counts in k and includes cost for known model', () => {
    const usage = { input_tokens: 12400, output_tokens: 300 };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    expect(out).toContain('12.4k');
    expect(out).toContain('in');
    expect(out).toContain('0.3k out');
    expect(out).toContain('$');
  });

  it('omits cost part for unknown model', () => {
    const usage = { input_tokens: 1000, output_tokens: 500 };
    const out = formatUsageFooter(usage, 'unknown-model');
    expect(out).toContain('1.0k');
    expect(out).toContain('in');
    expect(out).toContain('0.5k out');
    expect(out).not.toContain('$');
  });

  it('handles zero usage gracefully', () => {
    const out = formatUsageFooter({ input_tokens: 0, output_tokens: 0 }, 'claude-sonnet-4-6');
    expect(out).toContain('0.0k');
    expect(out).toContain('in');
    expect(out).toContain('0.0k out');
  });

  it('shows cached token count inline when cache_read_input_tokens > 0', () => {
    const usage = {
      input_tokens: 2100,
      output_tokens: 300,
      cache_read_input_tokens: 10300,
    };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    // Should look like "2.1k+10.3k(cached) in · 0.3k out · $..."
    expect(out).toContain('2.1k');
    expect(out).toContain('10.3k(cached)');
    expect(out).toContain('in');
    expect(out).toContain('0.3k out');
  });

  it('omits cached annotation when cache_read_input_tokens is 0 or absent', () => {
    const usage = { input_tokens: 1000, output_tokens: 200 };
    const out = formatUsageFooter(usage, 'claude-sonnet-4-6');
    expect(out).not.toContain('cached');
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
      total: { input_tokens: 100, output_tokens: 200 },
      model: 'unknown',
      stopReason: 'end_turn',
    });
    expect(out).toBe('Connected · last turn: 100 in / 200 out');
    expect(out).not.toContain('$');
  });

  it('does NOT include dollar amounts even for known models', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 500, output_tokens: 1500 },
      total: { input_tokens: 500, output_tokens: 1500 },
      model: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
    });
    expect(out).not.toContain('$');
    expect(out).toContain('500 in / 1500 out');
  });

  it('annotates a non-end_turn stop reason', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 10, output_tokens: 20 },
      total: { input_tokens: 10, output_tokens: 20 },
      model: 'unknown',
      stopReason: 'cancelled',
    });
    expect(out).toContain('cancelled');
  });

  it('annotates openrouter routes', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 10, output_tokens: 20 },
      total: { input_tokens: 10, output_tokens: 20 },
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
      total: { input_tokens: 10, output_tokens: 20 },
      model: 'unknown',
      stopReason: 'end_turn',
    });
    expect(out).toContain('cache hit 5000');
    expect(out).not.toContain('$');
  });
});
