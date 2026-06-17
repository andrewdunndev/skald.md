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
 * Applies prompt-caching cache_control breakpoints for Anthropic:
 *   - system is restructured as a text-block array with ephemeral cache_control
 *   - the last tool in the tools array gets ephemeral cache_control
 *
 * Only call this on the Anthropic path.
 */
export function applyAnthropicCaching(req: ChatRequest): ChatRequest {
  const out: ChatRequest = { ...req };

  // Wrap plain string system as a cached text block.
  if (typeof out.system === 'string' && out.system.length > 0) {
    out.system = [
      { type: 'text', text: out.system, cache_control: { type: 'ephemeral' } },
    ];
  }

  // Cache breakpoint on the last tool so Anthropic caches the tool
  // definitions block across turns.
  if (Array.isArray(out.tools) && out.tools.length > 0) {
    const tools = [...out.tools];
    const last = tools[tools.length - 1];
    tools[tools.length - 1] = {
      ...(last as Record<string, unknown>),
      cache_control: { type: 'ephemeral' },
    };
    out.tools = tools;
  }

  return out;
}
