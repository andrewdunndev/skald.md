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

import type { ChatRequest } from './protocol';

const ANTHROPIC_WEB_SEARCH_TYPES = ['web_search_20260209', 'web_search_20250305'];
const ANTHROPIC_WEB_FETCH_TYPES = ['web_fetch_20260209', 'web_fetch_20250910'];

const OR_WEB_SEARCH = 'openrouter:web_search';
const OR_WEB_FETCH = 'openrouter:web_fetch';
const OR_FETCH_ENGINE = 'openrouter';

/** Rewrite Anthropic server-tool definitions to OpenRouter's namespace. */
export function rewriteOpenRouterTools(req: ChatRequest): ChatRequest {
  if (!req.tools) return req;
  const tools = req.tools.map((t) => {
    const type =
      typeof (t as Record<string, unknown>).type === 'string'
        ? ((t as Record<string, unknown>).type as string)
        : undefined;
    if (type && ANTHROPIC_WEB_SEARCH_TYPES.includes(type)) {
      return rewriteWebSearch(t as Record<string, unknown>);
    }
    if (type && ANTHROPIC_WEB_FETCH_TYPES.includes(type)) {
      return rewriteWebFetch(t as Record<string, unknown>);
    }
    return t;
  });
  return { ...req, tools };
}

/** OpenRouter reads server-tool options only from a nested `parameters`. */
function withParameters(
  type: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  return Object.keys(parameters).length > 0 ? { type, parameters } : { type };
}

/** Rewrite an Anthropic web_search definition, carrying its cap. */
function rewriteWebSearch(src: Record<string, unknown>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  if (typeof src.max_uses === 'number') parameters.max_uses = src.max_uses;
  return withParameters(OR_WEB_SEARCH, parameters);
}

/**
 * Rewrite an Anthropic web_fetch definition to `openrouter:web_fetch`.
 *
 * SECURITY: the domain guard and the fetch cap travel in OpenRouter's
 * nested `parameters` object, the only place OpenRouter reads them.
 * OpenRouter's default `auto` engine uses the model provider's native
 * fetch where one exists, and native domain filtering varies by
 * provider, so a non-empty allow-list pins the `openrouter` engine,
 * which enforces `allowed_domains`. With no allow-list the default
 * engine stands.
 */
function rewriteWebFetch(src: Record<string, unknown>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  if (typeof src.max_uses === 'number') parameters.max_uses = src.max_uses;
  if (Array.isArray(src.allowed_domains)) {
    parameters.allowed_domains = src.allowed_domains;
    if (src.allowed_domains.length > 0) parameters.engine = OR_FETCH_ENGINE;
  }
  return withParameters(OR_WEB_FETCH, parameters);
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
