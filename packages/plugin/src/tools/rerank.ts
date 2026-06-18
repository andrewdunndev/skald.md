/**
 * LLM-as-reranker: reorder a candidate list by relevance to a query
 * using a cheap utility model as a ranking oracle.
 *
 * Calls Anthropic directly via Obsidian's requestUrl (non-streaming,
 * JSON) so it works on the direct-mode path without an extra WebSocket
 * turn. Applies a prompt-caching breakpoint on the system block so
 * repeated rerank calls within a session hit the cache.
 *
 * Soft-fail contract: on any error (no API key, bad JSON, network
 * failure), logs to console.warn and returns the original candidates
 * unchanged. The caller should never need to handle errors from this
 * function.
 *
 * The model string is supplied by the caller via utilityModel(settings)
 * from provider-capabilities.ts — no hardcoded model name here.
 */

import { requestUrl } from 'obsidian';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const RERANK_SYSTEM = `You are a relevance ranker. Given a user query and a numbered list of candidate items, output a JSON array of indices (0-based) sorted from most relevant to least relevant. Output ONLY the JSON array, no other text. Example: [2,0,1]`;

export interface RerankOpts {
  /** Max candidates to keep. Default 5. */
  topK?: number;
  /** Max candidates to pass to the reranker. Default 20. */
  maxInput?: number;
}

/**
 * Rerank up to maxInput candidates by relevance to query via a utility model.
 * Returns the top topK candidates in ranked order.
 * On any failure, returns the original candidates slice unchanged.
 *
 * @param query      - The search query to rank against.
 * @param candidates - Candidate strings to rerank.
 * @param apiKey     - Anthropic API key. Empty string disables rerank.
 * @param model      - Model id to use (e.g. from utilityModel(settings)).
 * @param opts       - Optional topK / maxInput overrides.
 */
export async function rerankCandidates(
  query: string,
  candidates: string[],
  apiKey: string,
  opts: RerankOpts = {},
  model = 'claude-haiku-4-5',
): Promise<string[]> {
  const topK = opts.topK ?? 5;
  const maxInput = opts.maxInput ?? 20;

  if (!apiKey) {
    console.warn('[rerank] no Anthropic API key — skipping rerank');
    return candidates.slice(0, topK);
  }

  const input = candidates.slice(0, maxInput);
  if (input.length <= topK) {
    return input;
  }

  const numbered = input
    .map((c, i) => `${i}: ${c}`)
    .join('\n');

  const userMessage = `Query: ${query}\n\nCandidates:\n${numbered}`;

  try {
    const resp = await requestUrl({
      url: ANTHROPIC_URL,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: [
          {
            type: 'text',
            text: RERANK_SYSTEM,
            // 1-hour TTL: rerank fires sporadically during a session
            // (only on noisy searches), often many minutes apart, so
            // the 5-minute ephemeral default would almost never hit.
            // 1h is GA (no beta header required). See pricing.ts.
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: userMessage }],
      }),
      throw: false,
    });

    if (resp.status !== 200) {
      console.warn(`[rerank] model returned ${resp.status} — skipping rerank`);
      return candidates.slice(0, topK);
    }

    const body = resp.json as Record<string, unknown>;
    const text =
      (body?.content as Array<{ type: string; text?: string }>)?.[0]?.text ??
      '';

    const indices: unknown = JSON.parse(text.trim());
    if (
      !Array.isArray(indices) ||
      !indices.every((x) => typeof x === 'number')
    ) {
      console.warn('[rerank] model returned unexpected JSON shape — skipping rerank');
      return candidates.slice(0, topK);
    }

    const ranked: string[] = [];
    for (const idx of indices as number[]) {
      if (idx >= 0 && idx < input.length) {
        ranked.push(input[idx]);
      }
      if (ranked.length >= topK) break;
    }

    // Pad with unreranked candidates if the model returned fewer than topK indices.
    if (ranked.length < topK) {
      for (const c of input) {
        if (!ranked.includes(c)) ranked.push(c);
        if (ranked.length >= topK) break;
      }
    }

    return ranked;
  } catch (err) {
    console.warn('[rerank] error calling rerank model —', err, '— skipping rerank');
    return candidates.slice(0, topK);
  }
}
