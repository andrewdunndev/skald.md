import { type ChatRequest, CAPTURE_MAX_PROMPT_BYTES, extractCaptureTitle } from '@scribian/protocol';
import type { Env } from '../env';
import { TokenRegistry, hasScope } from '../auth';
import { dispatchFor, resolveProviderKey } from '../providers';
import { authBearer } from './auth-helpers';

// CAPTURE_MAX_PROMPT_BYTES is the shared constant from @scribian/protocol —
// re-export for the worker's own tests that reference it by name here.
export { CAPTURE_MAX_PROMPT_BYTES } from '@scribian/protocol';

interface CaptureRequestBody {
  prompt?: string;
  kind?: string;
  /** Override provider for this capture. Defaults to whichever
   * provider the Worker has a key for (anthropic first if both). */
  provider?: 'anthropic' | 'openrouter';
}

/**
 * POST /capture — one-shot non-streaming Claude turn for the iOS
 * share-sheet capture flow. Uses the active provider dispatch so
 * Anthropic-direct OR OpenRouter both work; no Worker-side state
 * persists beyond the moment of generation (same posture as the
 * chat path).
 *
 * Request:  { prompt: string, kind?: 'url'|'text'|'image'|'pdf' }
 * Response: { body: string, title: string }
 */
export async function handleCaptureRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
): Promise<Response> {
  const auth = authBearer(req, registry);
  if (!auth.ok) return new Response(auth.reason, { status: auth.status });
  if (!hasScope(auth.result.scopes, 'chat')) {
    return new Response('token lacks chat scope', { status: 403 });
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  try {
    return await handleCapture(req, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal error';
    return new Response(msg, { status: 500 });
  }
}

async function handleCapture(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as CaptureRequestBody;
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) {
    return new Response('expected { prompt: "..." }', { status: 400 });
  }
  if (new TextEncoder().encode(prompt).length > CAPTURE_MAX_PROMPT_BYTES) {
    return new Response(
      `prompt exceeds ${CAPTURE_MAX_PROMPT_BYTES}-byte cap`,
      { status: 413 },
    );
  }
  const provider: 'anthropic' | 'openrouter' =
    body.provider === 'openrouter'
      ? 'openrouter'
      : body.provider === 'anthropic'
        ? 'anthropic'
        : env.ANTHROPIC_API_KEY
          ? 'anthropic'
          : 'openrouter';
  const apiKey = resolveProviderKey(provider, env, {});
  if (!apiKey) {
    return new Response(
      `No ${provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'} API key configured on the Worker for capture.`,
      { status: 503 },
    );
  }
  const model =
    provider === 'openrouter' ? 'anthropic/claude-sonnet-4-6' : 'claude-sonnet-4-6';
  const chatRequest: ChatRequest = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
  };
  const dispatch = dispatchFor(provider, apiKey, env, chatRequest);
  const resp = await fetch(dispatch.url, {
    method: 'POST',
    headers: dispatch.headers,
    body: JSON.stringify(dispatch.request),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return new Response(`upstream ${resp.status}: ${text.slice(0, 500)}`, {
      status: resp.status,
    });
  }
  const json = (await resp.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  if (!text) {
    return new Response('upstream returned no text content', { status: 502 });
  }
  // Title extraction via the shared protocol helper — plugin uses
  // this for the filename slug; falls back to a timestamp if the
  // model didn't produce a useful first line.
  const title = extractCaptureTitle(text);
  return Response.json({ body: text, title });
}
