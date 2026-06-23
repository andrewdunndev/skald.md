/**
 * OpenRouter ↔ Anthropic translation.
 *
 * OpenRouter's Anthropic-compatible endpoint accepts the Anthropic Messages
 * body but namespaces server-tool types (web search / fetch). These helpers
 * rewrite outbound tool definitions to OpenRouter's namespace and translate
 * inbound streaming content blocks back to the Anthropic shape so the rest of
 * the plugin sees one consistent event stream regardless of provider.
 *
 * Extracted from direct-transport.ts as a single named responsibility.
 */

import type { ChatRequest } from '@skald/protocol';

const ANTHROPIC_WEB_SEARCH_TYPES = ['web_search_20260209', 'web_search_20250305'];
const ANTHROPIC_WEB_FETCH_TYPES = ['web_fetch_20260209', 'web_fetch_20250910'];

const OR_WEB_SEARCH = 'openrouter:web_search';
const OR_WEB_FETCH = 'openrouter:web_fetch';

/** Rewrite Anthropic server-tool definitions to OpenRouter's namespace. */
export function rewriteOpenRouterTools(req: ChatRequest): ChatRequest {
  if (!req.tools) return req;
  const tools = req.tools.map((t) => {
    const type =
      typeof (t as Record<string, unknown>).type === 'string'
        ? ((t as Record<string, unknown>).type as string)
        : undefined;
    if (type && ANTHROPIC_WEB_SEARCH_TYPES.includes(type)) {
      return { type: OR_WEB_SEARCH };
    }
    if (type && ANTHROPIC_WEB_FETCH_TYPES.includes(type)) {
      return { type: OR_WEB_FETCH };
    }
    return t;
  });
  return { ...req, tools };
}

/** Translate an inbound OpenRouter streaming event back to Anthropic shape. */
export function translateOpenRouterEvent(
  event: string,
  data: unknown,
): { event: string; data: unknown } {
  if (!data || typeof data !== 'object') return { event, data };
  const obj = data as Record<string, unknown>;

  if (event === 'content_block_start') {
    const block = obj.content_block as Record<string, unknown> | undefined;
    if (block) {
      const translated = translateOpenRouterBlock(block);
      if (translated !== block) {
        return { event, data: { ...obj, content_block: translated } };
      }
    }
  }

  return { event, data };
}

function translateOpenRouterBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const blockType = typeof block.type === 'string' ? block.type : undefined;
  const blockName = typeof block.name === 'string' ? block.name : undefined;

  if (
    (blockType === 'tool_use' || blockType === 'server_tool_use') &&
    blockName
  ) {
    if (blockName === OR_WEB_SEARCH) {
      return { ...block, type: 'server_tool_use', name: 'web_search' };
    }
    if (blockName === OR_WEB_FETCH) {
      return { ...block, type: 'server_tool_use', name: 'web_fetch' };
    }
  }

  if (blockType === `${OR_WEB_SEARCH}_result`) {
    return { ...block, type: 'web_search_tool_result' };
  }
  if (blockType === `${OR_WEB_FETCH}_result`) {
    return { ...block, type: 'web_fetch_tool_result' };
  }

  return block;
}
