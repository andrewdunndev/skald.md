/**
 * Shared provider-agnostic utility-model completion helper.
 *
 * Used by rerank, memory-upkeep, and capture for their one-shot
 * non-streaming model calls. Both supported providers ('anthropic' and
 * 'openrouter') speak the Anthropic Messages wire format, so this helper
 * stays Anthropic-shaped throughout.
 *
 * OpenRouter exposes an Anthropic-compatible /v1/messages endpoint that
 * accepts the same body shape and returns the same content-block response.
 * Using that endpoint (rather than the OpenAI /chat/completions compat
 * surface) lets all callers share a single parse path.
 *
 * Soft-fail contract: returns { ok: false } on any non-2xx response
 * rather than throwing, so callers decide how to handle failures.
 */

import { requestUrl } from 'obsidian';
import type { Provider } from '@skald/protocol';
import { providerCapabilities } from './provider-capabilities';

export interface UtilityResult {
  ok: boolean;
  text: string | null;
  status: number;
  errorText?: string;
}

export async function utilityComplete(
  provider: Provider,
  apiKey: string,
  model: string,
  opts: {
    system?: string;
    userPrompt: string;
    maxTokens: number;
    cacheSystem?: boolean;
  },
): Promise<UtilityResult> {
  const caps = providerCapabilities(provider);

  // Build the request URL and headers per provider.
  let url: string;
  let headers: Record<string, string>;

  switch (provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/messages';
      headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };
      break;
    case 'openrouter':
      url = 'https://openrouter.ai/api/v1/messages';
      headers = {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://github.com/skald/skald',
        'X-OpenRouter-Title': 'skald',
      };
      break;
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { ok: false, text: null, status: 0, errorText: 'unknown provider' };
    }
  }

  // Build the request body (Anthropic Messages shape).
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens,
    messages: [{ role: 'user', content: opts.userPrompt }],
  };

  // Add system prompt only when non-empty, applying cache_control when
  // the provider supports prompt caching and opts.cacheSystem is set.
  if (opts.system) {
    if (opts.cacheSystem && caps.promptCaching) {
      body.system = [
        {
          type: 'text',
          text: opts.system,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ];
    } else {
      body.system = opts.system;
    }
  }

  const resp = await requestUrl({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    throw: false,
  });

  const ok = resp.status >= 200 && resp.status < 300;

  // Parse Anthropic-shaped content blocks.
  const text = (
    (resp.json?.content ?? []) as Array<{ type?: string; text?: string }>
  )
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');

  if (!ok) {
    return {
      ok: false,
      text: text || null,
      status: resp.status,
      errorText: String(resp.text ?? '').slice(0, 300),
    };
  }

  return { ok: true, text, status: resp.status };
}
