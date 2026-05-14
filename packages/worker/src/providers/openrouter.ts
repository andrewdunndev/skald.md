/**
 * OpenRouter fallback provider.
 *
 * OpenRouter exposes an Anthropic-compatible /api/v1/messages endpoint
 * that accepts the same Anthropic request body. Server tools are
 * declared as OpenRouter's own server-tool form
 * (openrouter:web_search + openrouter:web_fetch in the tools[] array),
 * which is the live surface as of 2026-05-14 — the older plugins[]
 * form is deprecated per https://openrouter.ai/docs/guides/features/plugins.
 *
 * The plugin sends scribian's canonical Anthropic-shaped server tool
 * declarations (web_search_20250305 + web_fetch_20250910). This module
 * rewrites them to OpenRouter's shape on outbound and rewrites the
 * response content blocks back to Anthropic-canonical names on
 * inbound, so the plugin renderer never branches on provider.
 *
 * Note: the exact response shape for OpenRouter's server-tool form
 * (tool_use + tool_result blocks vs annotations on the assistant
 * message) was partially verified by research dispatch S1 on
 * 2026-05-14. The translator below covers the tool_use + tool_result
 * path; if smoke tests reveal annotations-on-message instead, extend
 * transformOpenRouterEvent to handle that case.
 */
import type { ChatRequest, ToolDefinition } from '@scribian/protocol';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const OPENROUTER_MESSAGES_PATH = '/v1/messages';

const SCRIBIAN_REFERER = 'https://github.com/scribian/scribian';
const SCRIBIAN_TITLE = 'scribian';

// Anthropic native server tool types (the strings the plugin emits)
const ANTHROPIC_WEB_SEARCH_TYPES = ['web_search_20250305'];
const ANTHROPIC_WEB_FETCH_TYPES = ['web_fetch_20250910'];

// OpenRouter server tool types (what we send + receive on the wire)
const OR_WEB_SEARCH = 'openrouter:web_search';
const OR_WEB_FETCH = 'openrouter:web_fetch';

// Anthropic canonical content-block types for tool results (what the
// plugin renderer expects)
const ANTHROPIC_WEB_SEARCH_RESULT = 'web_search_tool_result';
const ANTHROPIC_WEB_FETCH_RESULT = 'web_fetch_tool_result';

export interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string;
  AI_GATEWAY_URL?: string;
}

export function openrouterUrl(env: OpenRouterEnv): string {
  // AI Gateway routing for OpenRouter (where the user has it
  // configured) — same host/path swap pattern as Anthropic.
  // The Gateway-for-OpenRouter case is not yet smoke-tested; if it
  // breaks, set AI_GATEWAY_URL only for Anthropic routes.
  if (env.AI_GATEWAY_URL && env.AI_GATEWAY_URL.includes('/openrouter')) {
    return env.AI_GATEWAY_URL;
  }
  return OPENROUTER_BASE_URL + OPENROUTER_MESSAGES_PATH;
}

export function openrouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    // Attribution headers — OpenRouter uses these for their rankings
    // dashboard. Set so scribian gets credit in their UI.
    'HTTP-Referer': SCRIBIAN_REFERER,
    'X-OpenRouter-Title': SCRIBIAN_TITLE,
  };
}

/**
 * Rewrite the plugin's Anthropic-shaped request for OpenRouter:
 *   - Replace Anthropic-native server tool declarations with
 *     OpenRouter's server-tool form (openrouter:web_search /
 *     openrouter:web_fetch).
 *   - Strip Anthropic-specific fields that don't apply on
 *     non-Anthropic models (cache_control markers on content blocks
 *     are silently ignored by OpenRouter for non-Anthropic models;
 *     we leave them alone for now and let OpenRouter drop them).
 *
 * Leaves user-defined tools alone — only the recognized Anthropic
 * server tool types are rewritten.
 */
export function transformOpenRouterRequest(req: ChatRequest): ChatRequest {
  if (!req.tools) return req;
  const tools = req.tools.map((t) => rewriteTool(t));
  return { ...req, tools };
}

function rewriteTool(tool: ToolDefinition): ToolDefinition {
  const type =
    typeof (tool as Record<string, unknown>).type === 'string'
      ? ((tool as Record<string, unknown>).type as string)
      : undefined;
  if (type && ANTHROPIC_WEB_SEARCH_TYPES.includes(type)) {
    return { type: OR_WEB_SEARCH };
  }
  if (type && ANTHROPIC_WEB_FETCH_TYPES.includes(type)) {
    return { type: OR_WEB_FETCH };
  }
  return tool;
}

/**
 * Translate OpenRouter SSE events back to Anthropic-canonical names
 * so the plugin renderer doesn't have to branch on provider.
 *
 * The known translations:
 *   - tool_use blocks with name=openrouter:web_search → name=web_search
 *     (Anthropic's server_tool_use uses name="web_search" with
 *     type="server_tool_use")
 *   - tool_result blocks with type=openrouter:web_search_result →
 *     type=web_search_tool_result
 *   - similar for web_fetch
 *
 * Unknown events / blocks pass through unchanged. The renderer's
 * "(unhandled block: type)" fallback handles anything we miss.
 */
export function transformOpenRouterEvent(
  event: string,
  data: unknown,
): { event: string; data: unknown } {
  if (!data || typeof data !== 'object') return { event, data };
  const obj = data as Record<string, unknown>;

  // content_block_start carries the new block — that's where we
  // translate tool_use names + tool_result types.
  if (event === 'content_block_start') {
    const block = obj.content_block as Record<string, unknown> | undefined;
    if (block) {
      const translated = translateBlock(block);
      if (translated !== block) {
        return { event, data: { ...obj, content_block: translated } };
      }
    }
  }

  // content_block_delta on a tool_use block carries input_json_delta;
  // names don't appear in deltas so no translation needed.

  return { event, data };
}

function translateBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const blockType = typeof block.type === 'string' ? block.type : undefined;
  const blockName = typeof block.name === 'string' ? block.name : undefined;

  // OpenRouter's server-tool form emits tool_use with name set to
  // the openrouter:* tool. Normalize to Anthropic's server_tool_use
  // shape with the canonical short names so the plugin's
  // describeToolUse handler picks them up.
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

  // tool_result for the server tool — map the OpenRouter result type
  // to the Anthropic canonical type so the plugin's existing handler
  // for web_search_tool_result / web_fetch_tool_result renders it.
  if (blockType === `${OR_WEB_SEARCH}_result`) {
    return { ...block, type: ANTHROPIC_WEB_SEARCH_RESULT };
  }
  if (blockType === `${OR_WEB_FETCH}_result`) {
    return { ...block, type: ANTHROPIC_WEB_FETCH_RESULT };
  }

  return block;
}
