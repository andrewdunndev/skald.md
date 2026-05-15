/**
 * Anthropic-direct provider. The original scribian transport — direct
 * to api.anthropic.com (or AI Gateway when AI_GATEWAY_URL is set).
 * Native server tools (web_search_20260209 + web_fetch_20260209) work
 * unchanged; nothing to translate on outbound or inbound.
 */
import type { ChatRequest } from '@scribian/protocol';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

const SCRIBIAN_USER_AGENT = 'scribian/0.0.1 (https://gitlab.com/dunn.dev/scribian)';

export interface AnthropicEnv {
  ANTHROPIC_API_KEY?: string;
  AI_GATEWAY_URL?: string;
}

/**
 * Build the upstream URL for an Anthropic request. AI Gateway, when
 * configured, fronts api.anthropic.com transparently; same shape +
 * key, just a different host.
 */
export function anthropicUrl(env: AnthropicEnv): string {
  return env.AI_GATEWAY_URL || ANTHROPIC_BASE_URL + ANTHROPIC_MESSAGES_PATH;
}

export function anthropicHeaders(
  apiKey: string,
  env: AnthropicEnv,
  model: string,
  hasTools: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'user-agent': SCRIBIAN_USER_AGENT,
  };
  if (env.AI_GATEWAY_URL) {
    headers['cf-aig-metadata'] = JSON.stringify({
      app: 'scribian',
      model,
      has_tools: hasTools,
    });
  }
  return headers;
}

/**
 * Anthropic accepts our ChatRequest shape verbatim — no transform.
 * Kept symmetric with openrouter.ts for the dispatch interface.
 */
export function transformAnthropicRequest(req: ChatRequest): ChatRequest {
  return req;
}

/**
 * Identity translator for inbound SSE events. Anthropic's native
 * shape is scribian's canonical shape, so nothing to translate.
 */
export function transformAnthropicEvent(
  event: string,
  data: unknown,
): { event: string; data: unknown } {
  return { event, data };
}
