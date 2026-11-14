/**
 * LLM-as-reranker: reorder a candidate list by relevance to a query
 * using a cheap utility model as a ranking oracle.
 *
 * Calls the shared utilityComplete helper (utility-call.ts). Prompt
 * caching (1h TTL) is applied when the active provider supports it;
 * otherwise the system block is sent as a plain string.
 *
 * Soft-fail contract: on any error (no API key, bad JSON, network
 * failure), logs to console.warn and returns the original candidates
 * unchanged. The caller should never need to handle errors from this
 * function.
 *
 * The model string is supplied by the caller via utilityModel(settings)
 * from provider-capabilities.ts — no hardcoded model name here.
 */

import type { Provider } from '../protocol';
import { utilityComplete } from '../utility-call';

const RERANK_SYSTEM = `You are a relevance ranker. Given a user query and a numbered list of candidate items, output a JSON array of indices (0-based) sorted from most relevant to least relevant. Output ONLY the JSON array, no other text. Example: [2,0,1]`;

export interface RerankOpts {
  /** Max candidates to keep. Default 5. */
  topK?: number;
  /** Max candidates to pass to the reranker. Default 20. */
  maxInput?: number;
  /** OpenAI-compatible base URL (provider==='openai' only). */
  baseUrl?: string;
}

/**
 * Rerank up to maxInput candidates by relevance to query via a utility model.
 * Returns the top topK candidates in ranked order.
 * On any failure, returns the original candidates slice unchanged.
 *
 * @param query    - The search query to rank against.
 * @param candidates - Candidate strings to rerank.
 * @param provider - Active provider (determines endpoint + auth).
 * @param apiKey   - API key for the active provider. Empty string disables rerank.
 * @param opts     - Optional topK / maxInput overrides.
 * @param model    - Model id to use (e.g. from utilityModel(settings)).
 */
export async function rerankCandidates(
  query: string,
  candidates: string[],
  provider: Provider,
  apiKey: string,
  opts: RerankOpts = {},
  model = 'claude-haiku-4-5',
): Promise<string[]> {
  const topK = opts.topK ?? 5;
  const maxInput = opts.maxInput ?? 20;

  if (!apiKey) {
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
    const res = await utilityComplete(provider, apiKey, model, {
      system: RERANK_SYSTEM,
      userPrompt: userMessage,
      maxTokens: 200,
      cacheSystem: true,
      baseUrl: opts.baseUrl,
    });

    if (!res.ok || !res.text) {
      console.warn(`[rerank] model returned ${res.status} — skipping rerank`);
      return candidates.slice(0, topK);
    }

    const indices: unknown = JSON.parse(res.text.trim());
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
    console.error('[rerank] error calling rerank model —', err, '— skipping rerank');
    return candidates.slice(0, topK);
  }
}
