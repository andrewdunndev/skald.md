/**
 * Prompt-caching helpers for the Anthropic direct path.
 *
 * Extracted from direct-transport.ts to keep that file under the
 * 400-line cap. Only used on the Anthropic provider path — OpenRouter
 * does not support prompt-caching breakpoints and must receive the
 * original request shape.
 */

import type { ChatRequest } from '@scribian/protocol';

/**
 * 1-hour cache_control for the long-lived prefix breakpoints.
 *
 * Rationale: scribian is a mobile app. Gaps between turns routinely
 * exceed the 5-minute ephemeral default, so the cache expires between
 * turns and every turn pays cache-CREATION (1.25x base) instead of
 * cache-READ (0.1x base) — caching backfires for exactly our common
 * user. The 1-hour TTL keeps the system + tools prefix warm across
 * multi-minute gaps.
 *
 * Cost trade-off: a 1-hour cache WRITE is 2x base (vs 1.25x for
 * 5-minute), so a fast user who would have hit the 5-minute cache
 * anyway pays slightly more on the (rare) miss. We default to 1h
 * anyway because the multi-minute-gap mobile case is the dominant
 * failure mode, and the prefix is reused many times once warm.
 *
 * GA as of 2026: no beta header required (per Anthropic prompt-caching
 * docs — 1-hour cache duration is generally available on the Claude
 * API). See pricing.ts for the encoded write/read multipliers.
 */
const CACHE_CONTROL_1H = { type: 'ephemeral', ttl: '1h' } as const;

/**
 * Applies prompt-caching cache_control breakpoints for Anthropic:
 *   - system is restructured as a text-block array with a 1-hour cache_control
 *   - the last tool in the tools array gets a 1-hour cache_control
 *
 * Both breakpoints use the same TTL, so the "longer TTL before shorter
 * TTL" ordering constraint can't be violated here.
 *
 * Only call this on the Anthropic path.
 */
export function applyAnthropicCaching(req: ChatRequest): ChatRequest {
  const out: ChatRequest = { ...req };

  // Wrap plain string system as a cached text block.
  if (typeof out.system === 'string' && out.system.length > 0) {
    out.system = [
      { type: 'text', text: out.system, cache_control: { ...CACHE_CONTROL_1H } },
    ];
  }

  // Cache breakpoint on the last tool so Anthropic caches the tool
  // definitions block across turns.
  if (Array.isArray(out.tools) && out.tools.length > 0) {
    const tools = [...out.tools];
    const last = tools[tools.length - 1];
    tools[tools.length - 1] = {
      ...(last as Record<string, unknown>),
      cache_control: { ...CACHE_CONTROL_1H },
    };
    out.tools = tools;
  }

  return out;
}
