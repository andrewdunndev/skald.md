/**
 * Vault-memory upkeep pass — provider-neutral.
 *
 * After a conversation turn, a cheap utility-model call reviews the
 * recent exchange against the current memory note and proposes an
 * updated note body (additions, corrections, pruning). The proposal
 * routes through the existing diff-card approval flow — the user sees
 * exactly what changed before anything lands in the vault.
 *
 * Provider-agnostic: the endpoint is selected by provider. Anthropic
 * uses the Anthropic messages API directly (like rerank.ts). OpenRouter
 * uses the OpenRouter messages endpoint. The model is resolveUtilityModel
 * (Haiku tier by default, overridable via settings.utilityModel).
 *
 * Soft-fail contract: on any error (network, parse, bad key) the
 * function returns null and logs a warning. The caller never needs to
 * handle errors; memory upkeep is advisory and must never block chat.
 *
 * Cadence: runs every UPKEEP_EVERY_N_TURNS turns. Callers track the
 * turn counter and pass it in; this module has no state.
 */

import { requestUrl } from 'obsidian';
import type { Message, Provider } from '@scribian/protocol';

/** Run upkeep every this many finalized turns. Conservative default
 * keeps utility-model cost low. Exposed so callers can test. */
export const UPKEEP_EVERY_N_TURNS = 5;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_VERSION = '2023-06-01';

const UPKEEP_SYSTEM = `You are a memory-note curator for a personal AI assistant. You will receive the user's current memory note and a recent conversation excerpt. Your job is to return an UPDATED memory note that:
- Adds new durable facts the user revealed (preferences, names, projects, recurring context)
- Updates facts that have changed
- Removes facts that are now stale or explicitly countermanded
- Keeps unchanged facts verbatim to avoid unnecessary diffs

Return ONLY the updated note body — no explanation, no markdown fences, no preamble. If nothing needs changing, return the original note unchanged. One fact per line is the preferred format.`;

/** Conversation exchange passed to the upkeep model. We send only
 * the last few messages — enough context to spot new facts without
 * blowing the utility model's token budget. */
const MAX_EXCHANGE_MESSAGES = 6;

/**
 * Options for a single upkeep pass.
 */
export interface UpkeepOpts {
  /** Current memory note body (may be empty string). */
  memoryBody: string;
  /** Recent conversation messages (we tail to MAX_EXCHANGE_MESSAGES). */
  messages: readonly Message[];
  /** Utility model id (from utilityModel(settings)). */
  model: string;
  /** Active provider — determines which endpoint to call. */
  provider: Provider;
  /** API key for the active provider. Empty string → soft-fail. */
  apiKey: string;
}

/**
 * Proposed new memory-note body, or null when upkeep is a no-op or
 * the call failed.
 */
export type UpkeepProposal = string | null;

/**
 * Call the utility model to propose an updated memory note.
 * Soft-fails to null on any error.
 */
export async function proposeMemoryUpkeep(
  opts: UpkeepOpts,
): Promise<UpkeepProposal> {
  if (!opts.apiKey) {
    console.warn('[memory-upkeep] no API key — skipping');
    return null;
  }

  const exchange = buildExchangeText(opts.messages);
  const userPrompt =
    `Current memory note:\n<memory>\n${opts.memoryBody || '(empty)'}\n</memory>\n\n` +
    `Recent conversation:\n${exchange}\n\nReturn the updated memory note:`;

  try {
    const proposed = await callUtilityModel(opts.provider, opts.apiKey, opts.model, userPrompt);
    if (!proposed) return null;
    // If the model returned the same content, propose nothing.
    if (proposed.trim() === opts.memoryBody.trim()) return null;
    return proposed.trim();
  } catch (err) {
    console.warn('[memory-upkeep] error —', err);
    return null;
  }
}

/** Format recent messages as a compact exchange transcript. */
function buildExchangeText(messages: readonly Message[]): string {
  const recent = messages.slice(-MAX_EXCHANGE_MESSAGES);
  return recent
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const text = typeof m.content === 'string'
        ? m.content
        : (m.content as Record<string, unknown>[])
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => (b as { text: string }).text)
            .join(' ');
      return `${role}: ${text.slice(0, 300)}`;
    })
    .join('\n');
}

/** Dispatch to the correct provider endpoint. Returns the model's
 * text response, or null on unexpected shape. */
async function callUtilityModel(
  provider: Provider,
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<string | null> {
  switch (provider) {
    case 'anthropic':
      return callAnthropic(apiKey, model, userPrompt);
    case 'openrouter':
      return callOpenRouter(apiKey, model, userPrompt);
    default: {
      // Exhaustiveness: if Provider gains a new value the compiler
      // will error here (provider satisfies never pattern).
      const _exhaustive: never = provider;
      console.warn('[memory-upkeep] unknown provider:', _exhaustive);
      return null;
    }
  }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<string | null> {
  const resp = await requestUrl({
    url: ANTHROPIC_URL,
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: UPKEEP_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    throw: false,
  });
  if (resp.status !== 200) {
    console.warn(`[memory-upkeep] Anthropic returned ${resp.status}`);
    return null;
  }
  const body = resp.json as Record<string, unknown>;
  return extractAnthropicText(body);
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  userPrompt: string,
): Promise<string | null> {
  const resp = await requestUrl({
    url: OPENROUTER_URL,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://scribian.dunn.dev',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [
        { role: 'system', content: UPKEEP_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    }),
    throw: false,
  });
  if (resp.status !== 200) {
    console.warn(`[memory-upkeep] OpenRouter returned ${resp.status}`);
    return null;
  }
  const body = resp.json as Record<string, unknown>;
  return extractOpenRouterText(body);
}

function extractAnthropicText(body: Record<string, unknown>): string | null {
  const content = body?.content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.text ?? null;
}

function extractOpenRouterText(body: Record<string, unknown>): string | null {
  const choices = body?.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content ?? null;
}

/**
 * True when the turn counter indicates an upkeep pass is due.
 * Callers increment their counter after each finalized turn and check
 * this before calling proposeMemoryUpkeep.
 */
export function isUpkeepDue(turnsSinceUpkeep: number): boolean {
  return turnsSinceUpkeep >= UPKEEP_EVERY_N_TURNS;
}
