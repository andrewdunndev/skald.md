/**
 * Per-model pricing for cost estimation. Surfaced in:
 *   - the chat status row (running per-conversation total)
 *   - saved conversation markdown frontmatter (estimated_cost_usd)
 *
 * Rates are $/million tokens. Update when Anthropic / OpenRouter
 * publish new pricing — this is a knowingly-stale table, accuracy
 * within $0.01 isn't the goal; surfacing the order of magnitude
 * on a premium-token mobile budget is.
 *
 * Pricing source (Anthropic docs, verified 2026-06-17):
 *   https://platform.claude.com/docs/en/docs/about-claude/models/overview
 *   - claude-opus-4-8: $5 / $25 input/output
 *   - claude-opus-4-7: $5 / $25 input/output
 *   - claude-sonnet-4-6: $3 / $15, cache_read $0.30, cache_write $6.00
 *   - claude-haiku-4-5: $1 / $5, cache_read $0.10, cache_write $2.00
 *
 * cache_write rates above are the 1-HOUR-TTL write rate (2x base
 * input), because scribian writes its system+tools prefix with a
 * 1-hour TTL (see anthropic-caching.ts) to survive multi-minute
 * mobile gaps. cache_read stays 0.1x base regardless of TTL. Per
 * Anthropic prompt-caching docs: 5-min write = 1.25x, 1-hour write =
 * 2x, read = 0.1x base input.
 *
 * OpenRouter rates vary per model; surfaced via their pricing API
 * but kept as a rough Sonnet baseline here for non-Anthropic routes
 * (cost surface is "indicative" — the actual bill comes from your
 * OpenRouter dashboard).
 */

import type { Usage } from '@scribian/protocol';

export interface ModelPricing {
  /** Input tokens, $/M */
  input: number;
  /** Output tokens, $/M */
  output: number;
  /** Cache-hit reads, $/M (lower than input). Defaults to input
   * rate if absent. */
  cacheRead?: number;
  /** Cache writes / creation, $/M. For scribian this is the
   * 1-hour-TTL write rate (2x base input). Defaults to input rate if
   * absent. */
  cacheWrite?: number;
}

/** Pricing table keyed by canonical model id (Anthropic names) and
 * by an OpenRouter-style namespaced fallback. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus 4.8: $5/M input, $25/M output. Cache rates follow the
  // standard pattern: cache_read = 0.1x input ($0.50), cache_write
  // (1-hour TTL) = 2x input ($10). Source: Anthropic models page,
  // verified 2026-06-17.
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 10,
  },
  // Opus 4.7: same tier pricing as Opus 4.8 ($5/$25). Retaining for
  // users on the older model.
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 10,
  },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    // 1-hour-TTL write = 2x base input ($3 → $6).
    cacheWrite: 6,
  },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    // 1-hour-TTL write = 2x base input ($1 → $2).
    cacheWrite: 2,
  },
};

/**
 * Estimate the USD cost of a single chat turn. Returns 0 for
 * unknown models — accuracy isn't the contract, surfacing-when-we-
 * can is. Cache tokens are billed at the discounted rates when
 * present in the usage payload.
 */
export function estimateTurnCost(usage: Usage, model: string): number {
  const price = lookupPricing(model);
  if (!price) return 0;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  const inputRate = price.input;
  const outputRate = price.output;
  const cacheReadRate = price.cacheRead ?? price.input;
  const cacheWriteRate = price.cacheWrite ?? price.input;

  // input_tokens from the API counts uncached input tokens —
  // cache_read + cache_create are billed separately at their own
  // rates. Sum the three lines for the input side.
  return (
    (inputTokens * inputRate +
      outputTokens * outputRate +
      cacheRead * cacheReadRate +
      cacheWrite * cacheWriteRate) /
    1_000_000
  );
}

/**
 * Look up a model's pricing. Strips OpenRouter's namespacing
 * (`anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6`) so a turn
 * routed through OpenRouter to a known Anthropic model still
 * surfaces a useful estimate.
 */
function lookupPricing(model: string): ModelPricing | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Strip leading namespace (anthropic/, openai/, meta-llama/, etc).
  const idx = model.indexOf('/');
  if (idx >= 0) {
    const stripped = model.slice(idx + 1);
    if (MODEL_PRICING[stripped]) return MODEL_PRICING[stripped];
  }
  return null;
}

/** Format a USD cost for display. Below $0.01 shows three decimal
 * places (sub-cent precision matters on mobile-burst flows). */
export function formatCostUSD(cost: number): string {
  if (cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/** Aggregate usage across multiple turns. Adds undefined cache fields
 * to zero so the result is a fully-populated Usage object. */
export function sumUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) +
      (b.cache_creation_input_tokens ?? 0),
  };
}

/**
 * Format running session usage as a compact footer line for the chat pane.
 * Shown after every turn so users can self-regulate token spend.
 * Example: "12.4k in · 0.3k out · $0.04"
 *
 * Pure function — no view-layer dependencies so it's easy to test.
 */
export function formatUsageFooter(total: Usage, model: string): string {
  const inK = ((total.input_tokens ?? 0) / 1000).toFixed(1);
  const outK = ((total.output_tokens ?? 0) / 1000).toFixed(1);
  const cachedRead = total.cache_read_input_tokens ?? 0;
  const cachedPart =
    cachedRead > 0 ? `+${(cachedRead / 1000).toFixed(1)}k(cached)` : '';
  const cost = estimateTurnCost(total, model);
  const costPart = cost > 0 ? ` · ${formatCostUSD(cost)}` : '';
  return `${inK}k${cachedPart} in · ${outK}k out${costPart}`;
}

/**
 * Footer line carrying BOTH the current chat's running cost and the
 * app-session cumulative cost (across chats cleared via New Chat).
 * Example: "this chat: $0.04 · session: $0.21". Compact + muted in
 * the UI; the session figure exists to reassure cost-anxious users
 * that the running total is bounded.
 *
 * `sessionPriorUSD` is the cost of all PREVIOUS (cleared) chats this
 * session; `chatUSD` is the current chat's cost. The session figure
 * is their sum so it updates live as the current chat grows. When the
 * session total equals the current chat (first chat, nothing cleared
 * yet), only the chat figure is shown to avoid redundant noise.
 */
export function formatSessionFooter(
  total: Usage,
  model: string,
  sessionPriorUSD: number,
): string {
  const base = formatUsageFooter(total, model);
  const chatCost = estimateTurnCost(total, model);
  if (chatCost <= 0) return base;
  const sessionCost = sessionPriorUSD + chatCost;
  // Only surface the session figure once there's prior spend to add.
  if (sessionPriorUSD <= 0) return base;
  return `${base} · session: ${formatCostUSD(sessionCost)}`;
}

/**
 * Compose the chat status row text for a finished turn. Shows
 * connection status, model route, raw token counts, and cache hit —
 * but NOT dollar amounts (those live exclusively in the usage footer
 * so cost appears in exactly one place).
 */
export function formatTurnStatus(input: {
  usage: Usage;
  model: string;
  provider?: string;
  stopReason: string;
}): string {
  const cache = input.usage.cache_read_input_tokens
    ? ` (cache hit ${input.usage.cache_read_input_tokens})`
    : '';
  const stop =
    input.stopReason !== 'end_turn' ? ` · ${input.stopReason}` : '';
  const via = input.provider === 'openrouter' ? ' · openrouter' : '';
  return `Connected · last turn${via}: ${input.usage.input_tokens ?? 0} in / ${input.usage.output_tokens ?? 0} out${cache}${stop}`;
}
