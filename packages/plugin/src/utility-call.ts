/**
 * Shared provider-agnostic utility-model completion helper.
 *
 * Used by rerank, memory-upkeep, and capture for their one-shot
 * non-streaming model calls. 'anthropic' and 'openrouter' speak the
 * Anthropic Messages wire format and share a content-block parse path.
 *
 * OpenRouter exposes an Anthropic-compatible /v1/messages endpoint that
 * accepts the same body shape and returns the same content-block response.
 * Using that endpoint (rather than the OpenAI /chat/completions compat
 * surface) lets the two Anthropic-shaped callers share a single parse.
 *
 * 'openai' targets an OpenAI-compatible /chat/completions endpoint at a
 * caller-supplied baseUrl: Bearer auth, OpenAI request body (no
 * cache_control), and a string content parse (choices[0].message.content).
 *
 * Soft-fail contract: returns { ok: false } on any non-2xx response
 * rather than throwing, so callers decide how to handle failures.
 */

import { requestUrl } from 'obsidian';
import type { Provider } from './protocol';
import { providerCapabilities } from './provider-capabilities';
import { validateOpenAiBaseUrl } from './openai-base-url';

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
    /** Base URL for an OpenAI-compatible endpoint (provider==='openai').
     * Ignored for anthropic/openrouter. */
    baseUrl?: string;
  },
): Promise<UtilityResult> {
  const caps = providerCapabilities(provider);

  // Build the request URL, headers, and body per provider. OpenAI-compatible
  // endpoints use the /chat/completions wire shape; anthropic/openrouter use
  // the Anthropic Messages shape.
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  // Whether the response parses as OpenAI choices (string) vs Anthropic
  // content blocks.
  let parseShape: 'anthropic' | 'openai' = 'anthropic';

  switch (provider) {
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/messages';
      headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };
      body = buildAnthropicBody(model, opts, caps.promptCaching);
      break;
    case 'openrouter':
      url = 'https://openrouter.ai/api/v1/messages';
      headers = {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://gitlab.com/dunn.dev/skald.md',
        'X-OpenRouter-Title': 'skald',
      };
      body = buildAnthropicBody(model, opts, caps.promptCaching);
      break;
    case 'openai': {
      // Defense-in-depth: even though loadSettings clamps an insecure
      // openaiBaseUrl, refuse here too so prompts + the API key can never be
      // dispatched over a cleartext non-loopback URL (the rule must hold no
      // matter which path supplied the base URL).
      const rawBase = opts.baseUrl ?? '';
      const validation = validateOpenAiBaseUrl(rawBase);
      if (!rawBase.trim() || !validation.ok) {
        return {
          ok: false,
          text: null,
          status: 0,
          errorText:
            validation.error ?? 'No OpenAI-compatible base URL configured.',
        };
      }
      const base = rawBase.replace(/\/$/, '');
      url = `${base}/chat/completions`;
      headers = {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      };
      // OpenAI request shape: a flat messages array with an optional
      // leading system message. Never carries cache_control. Newer OpenAI
      // models reject the deprecated max_tokens, so emit max_completion_tokens.
      body = {
        model,
        max_completion_tokens: opts.maxTokens,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: opts.userPrompt },
        ],
      };
      parseShape = 'openai';
      break;
    }
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { ok: false, text: null, status: 0, errorText: 'unknown provider' };
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

  // Parse per response shape.
  const text =
    parseShape === 'openai'
      ? ((resp.json?.choices?.[0]?.message?.content as string | undefined) ?? '')
      : (
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

/** Build the Anthropic Messages request body shared by the anthropic and
 * openrouter providers. Applies cache_control on the system block only when
 * the provider supports prompt caching and opts.cacheSystem is set. */
function buildAnthropicBody(
  model: string,
  opts: { system?: string; userPrompt: string; maxTokens: number; cacheSystem?: boolean },
  promptCaching: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens,
    messages: [{ role: 'user', content: opts.userPrompt }],
  };
  if (opts.system) {
    if (opts.cacheSystem && promptCaching) {
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
  return body;
}
