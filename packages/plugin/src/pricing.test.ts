import { describe, expect, it } from 'vitest';
import {
  estimateTurnCost,
  formatCostUSD,
  formatTurnStatus,
  formatUsageFooter,
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

  it('applies the cache_write rate when usage has cache_creation_input_tokens', () => {
    // 1M cache_write at $3.75/M = $3.75
    const cost = estimateTurnCost(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
      },
      'claude-sonnet-4-6',
    );
    expect(cost).toBeCloseTo(3.75, 3);
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
    expect(out).toContain('12.4k in');
    expect(out).toContain('0.3k out');
    expect(out).toContain('$');
  });

  it('omits cost part for unknown model', () => {
    const usage = { input_tokens: 1000, output_tokens: 500 };
    const out = formatUsageFooter(usage, 'unknown-model');
    expect(out).toContain('1.0k in');
    expect(out).toContain('0.5k out');
    expect(out).not.toContain('$');
  });

  it('handles zero usage gracefully', () => {
    const out = formatUsageFooter({ input_tokens: 0, output_tokens: 0 }, 'claude-sonnet-4-6');
    expect(out).toContain('0.0k in');
    expect(out).toContain('0.0k out');
  });
});

describe('formatTurnStatus', () => {
  it('formats a basic turn without a cost on unknown models', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 100, output_tokens: 200 },
      total: { input_tokens: 100, output_tokens: 200 },
      model: 'unknown',
      stopReason: 'end_turn',
    });
    expect(out).toBe('Connected · last turn: 100 in / 200 out');
  });

  it('includes a cost annotation when the model is known', () => {
    const out = formatTurnStatus({
      usage: { input_tokens: 500, output_tokens: 1500 },
      total: { input_tokens: 500, output_tokens: 1500 },
      model: 'claude-sonnet-4-6',
      stopReason: 'end_turn',
    });
    // turn = total here, so cost = total cost
    expect(out).toContain('$0.024');
    expect(out).toContain('total $0.024');
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
  });
});
