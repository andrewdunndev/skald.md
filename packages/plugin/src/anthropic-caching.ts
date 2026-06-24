/**
 * Prompt-caching helpers for the Anthropic direct path.
 *
 * Extracted from direct-transport.ts to keep that file under the
 * 400-line cap. Only used on the Anthropic provider path — OpenRouter
 * does not support prompt-caching breakpoints and must receive the
 * original request shape.
 */

import type { ChatRequest } from '@skald/protocol';

/**
 * 1-hour cache_control for the long-lived prefix breakpoints.
 *
 * Rationale: skald is a mobile app. Gaps between turns routinely
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
 *   - the last content block of the second-to-last message (the prior turn)
 *     gets a 1-hour cache_control — caches everything up to and including
 *     the prior turn; only the newest user message is uncached. Each turn
 *     the breakpoint naturally moves forward (moving history breakpoint).
 *
 * All three breakpoints use the same 1-hour TTL. Anthropic allows up to
 * 4 breakpoints; we use at most 3, so we're within the limit.
 *
 * History-window interaction: if history-window truncation removes the
 * message that held the prior-turn breakpoint, the cache prefix shifts
 * and the next turn pays cache-creation cost (one rebuild). This is
 * acceptable; no fix is needed here.
 *
 * Only call this on the Anthropic path.
 */
export function applyAnthropicCaching(req: ChatRequest): ChatRequest {
  const out: ChatRequest = { ...req };

  // System caching. A plain string becomes one cached block (whole system
  // cached). A block array is loadSystemPrompt's [stable, …volatile] shape:
  // put the breakpoint on the FIRST (stable) block only, so the stable prefix
  // stays cached while a trailing volatile block — the memory note, which
  // memory-upkeep rewrites between turns — is re-sent fresh WITHOUT busting
  // the cached prefix. (Caching is prefix-based, so the memory block sits
  // after the stable breakpoint; re-processing it does not re-write the ~10k
  // stable prefix or the tools block.)
  if (typeof out.system === 'string' && out.system.length > 0) {
    out.system = [
      { type: 'text', text: out.system, cache_control: { ...CACHE_CONTROL_1H } },
    ];
  } else if (Array.isArray(out.system) && out.system.length > 0) {
    const blocks = out.system.map((b) => ({ ...(b as Record<string, unknown>) }));
    for (const b of blocks) delete b.cache_control;
    blocks[0] = { ...blocks[0], cache_control: { ...CACHE_CONTROL_1H } };
    out.system = blocks as ChatRequest['system'];
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

  // Moving history breakpoint: cache everything up to and including the
  // prior turn. Place cache_control on the LAST content block of the
  // second-to-last message (messages[length - 2]).
  if (Array.isArray(out.messages) && out.messages.length >= 2) {
    const messages = [...out.messages];
    const priorMsg = messages[messages.length - 2];
    const content = priorMsg.content;

    if (typeof content === 'string') {
      // String content: wrap as a single text block with cache_control.
      // This converts the message content to the block-array form so
      // Anthropic can attach the breakpoint.
      messages[messages.length - 2] = {
        ...priorMsg,
        content: [
          { type: 'text', text: content, cache_control: { ...CACHE_CONTROL_1H } },
        ],
      };
    } else if (Array.isArray(content) && content.length > 0) {
      // Block-array content: attach cache_control to the last block.
      const blocks = [...content];
      const lastBlock = blocks[blocks.length - 1];
      blocks[blocks.length - 1] = {
        ...(lastBlock as Record<string, unknown>),
        cache_control: { ...CACHE_CONTROL_1H },
      };
      messages[messages.length - 2] = { ...priorMsg, content: blocks };
    }
    // If content is neither string nor array (e.g. undefined), skip gracefully.

    out.messages = messages;
  }

  return out;
}
