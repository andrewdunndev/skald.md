/**
 * Provider dispatch. The DO calls into here to:
 *   - resolve the per-provider upstream URL + auth headers
 *   - transform the outbound ChatRequest for provider-specific shape
 *     differences (currently: OpenRouter server tools)
 *   - transform inbound SSE events back to scribian's canonical shape
 *     so the plugin renderer never branches on provider
 *
 * Provider routing is decided at the ClientMessage level (not inside
 * the ChatRequest body) — the request body stays "what we POST to the
 * upstream" while the wrapping ClientMessage.provider says "where".
 *
 * Phase 5 (2026-05-14): Anthropic + OpenRouter only. Direct OpenAI /
 * Workers AI peer providers were considered and rejected — OpenRouter
 * covers the entire long tail behind one Anthropic-compatible
 * endpoint, so the dispatch shape stays narrow.
 */
import type { ChatRequest, Provider } from '@scribian/protocol';
import {
  anthropicHeaders,
  anthropicUrl,
  transformAnthropicEvent,
  transformAnthropicRequest,
  type AnthropicEnv,
} from './anthropic';
import {
  openrouterHeaders,
  openrouterUrl,
  transformOpenRouterEvent,
  transformOpenRouterRequest,
  type OpenRouterEnv,
} from './openrouter';

export type { Provider };

export interface ProviderEnv extends AnthropicEnv, OpenRouterEnv {}

export interface ProviderDispatch {
  /** Final URL to POST. */
  url: string;
  /** Headers for the upstream request. */
  headers: Record<string, string>;
  /** ChatRequest after outbound translation. */
  request: ChatRequest;
  /** Translate inbound SSE events back to scribian-canonical shape. */
  translateEvent: (
    event: string,
    data: unknown,
  ) => { event: string; data: unknown };
}

/**
 * Build the full dispatch context for a provider given the upstream
 * API key, env, and original ChatRequest.
 *
 * Caller is responsible for providing the right per-provider key
 * (anthropic_api_key for 'anthropic', openrouter_api_key for
 * 'openrouter') — this function does NOT pick which key to use; it
 * only consumes the one passed in.
 */
export function dispatchFor(
  provider: Provider,
  apiKey: string,
  env: ProviderEnv,
  req: ChatRequest,
): ProviderDispatch {
  if (provider === 'openrouter') {
    const request = transformOpenRouterRequest(req);
    return {
      url: openrouterUrl(env),
      headers: openrouterHeaders(apiKey),
      request,
      translateEvent: transformOpenRouterEvent,
    };
  }
  // Anthropic (default)
  const request = transformAnthropicRequest(req);
  const hasTools = !!(request.tools && request.tools.length > 0);
  return {
    url: anthropicUrl(env),
    headers: anthropicHeaders(apiKey, env, request.model, hasTools),
    request,
    translateEvent: transformAnthropicEvent,
  };
}

/**
 * Resolve which provider key applies for a given provider, preferring
 * the plugin-supplied key over the Worker secret. Returns undefined
 * if neither is configured — caller surfaces this as a clear error
 * to the plugin.
 */
export function resolveProviderKey(
  provider: Provider,
  env: ProviderEnv,
  pluginSupplied: {
    anthropic_api_key?: string;
    openrouter_api_key?: string;
  },
): string | undefined {
  if (provider === 'openrouter') {
    return (
      pluginSupplied.openrouter_api_key?.trim() ||
      env.OPENROUTER_API_KEY ||
      undefined
    );
  }
  return (
    pluginSupplied.anthropic_api_key?.trim() ||
    env.ANTHROPIC_API_KEY ||
    undefined
  );
}
