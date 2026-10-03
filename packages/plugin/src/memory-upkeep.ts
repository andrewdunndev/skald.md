/**
 * Vault-memory upkeep pass — provider-neutral.
 *
 * After a conversation turn, a cheap utility-model call reviews the
 * recent exchange against the current memory note and proposes an
 * updated note body (additions, corrections, pruning). The proposal
 * routes through the existing diff-card approval flow — the user sees
 * exactly what changed before anything lands in the vault.
 *
 * Provider-agnostic: the endpoint is selected by provider via the
 * shared utilityComplete helper. Both 'anthropic' and 'openrouter' use
 * the Anthropic Messages wire format (/v1/messages endpoint). The model
 * is the per-provider utility default (Haiku tier).
 *
 * Soft-fail contract: on any error (network, parse, bad key) the
 * function returns null and logs a warning. The caller never needs to
 * handle errors; memory upkeep is advisory and must never block chat.
 *
 * Cadence: runs every UPKEEP_EVERY_N_TURNS turns. Callers track the
 * turn counter and pass it in; this module has no state.
 */

import type { Message, Provider } from './protocol';
import { utilityComplete } from './utility-call';

/** Run upkeep every this many finalized turns. Conservative default
 * keeps utility-model cost low. Exposed so callers can test. */
export const UPKEEP_EVERY_N_TURNS = 5;

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
 * Hard output cap for the upkeep call. The model is asked to return the
 * FULL updated note, which then becomes a whole-note overwrite — so this
 * must be high enough to never truncate a realistic memory note. The old
 * 512 cap silently truncated any note longer than ~512 tokens and wrote
 * the truncated body back, permanently losing facts on approval. 8192 is
 * far above any plausible single memory note (Haiku tier supports 64K)
 * and leaves generous headroom over the input we send. We never want a
 * proposed body that is a truncated version of a longer note.
 */
const UPKEEP_MAX_TOKENS = 8192;

/**
 * Deletion guard. If the proposed body drops more than this fraction of
 * the existing note's non-whitespace length, the proposal is treated as
 * suspect (a hallucinated wipe, a truncated response, a model that
 * misunderstood the task) and is NOT surfaced — a non-technical user
 * must never be shown a destructive whole-note overwrite to rubber-stamp.
 * Conservative behavior: skip the proposal entirely and log a warning.
 * Expressed as the maximum allowed drop fraction (0.40 = up to 40% may be
 * pruned; more than that is rejected).
 */
export const UPKEEP_MAX_DELETION_FRACTION = 0.4;

/** Non-whitespace character count — the basis for the deletion guard so
 * that reflowing/reformatting (which the no-op normalizer already filters)
 * doesn't register as content loss. */
function nonWhitespaceLength(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/**
 * Split a note into its YAML frontmatter block and body.
 *
 * A frontmatter block is a leading `---\n…\n---` (or `---\r\n…\r\n---`)
 * delimited section. The returned `frontmatter` string includes the
 * surrounding `---` fence lines (and the trailing newline) exactly as they
 * appear in the source — so re-joining `frontmatter + body` reproduces the
 * original note verbatim.
 *
 * If the note has no frontmatter, `frontmatter` is the empty string and
 * `body` is the entire note unchanged.
 *
 * Pure — no I/O, no side-effects. Exported so callers (and tests) can
 * use it independently.
 */
export function splitFrontmatter(note: string): { frontmatter: string; body: string } {
  // Must begin with --- (optionally followed by \r) then a newline.
  if (!note.startsWith('---')) {
    return { frontmatter: '', body: note };
  }
  const afterOpen = note.indexOf('\n');
  if (afterOpen === -1) {
    return { frontmatter: '', body: note };
  }
  // Search for the closing --- on its own line after the opening fence.
  const rest = note.slice(afterOpen + 1);
  // Match `---` at the start of a line (possibly preceded by \r if CRLF).
  const closeMatch = /^---[ \t]*$/m.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: '', body: note };
  }
  const closeEnd = afterOpen + 1 + closeMatch.index + closeMatch[0].length;
  // Include the newline after the closing fence if present.
  const trailingNl = note[closeEnd] === '\n' ? 1 : 0;
  const frontmatter = note.slice(0, closeEnd + trailingNl);
  const body = note.slice(closeEnd + trailingNl);
  return { frontmatter, body };
}

/**
 * Normalize a note body for no-op comparison: trim each line, drop blank
 * lines, and join with single newlines. A chatty utility model can return
 * a cosmetically-different body (reordered blank lines, trailing spaces,
 * re-wrapped indentation) that isn't equal-after-a-single-trim — surfacing
 * that as a diff card nags the user about a change that carries no new
 * facts. Comparing normalized forms suppresses cosmetic-only diffs while
 * still surfacing any real content change.
 */
export function normalizeNoteBody(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

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
  /** API key for the active provider. Empty string → soft-fail
   * (except provider==='openai', which may legitimately need no key). */
  apiKey: string;
  /** OpenAI-compatible base URL (provider==='openai' only). */
  baseUrl?: string;
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
  // OpenAI-compatible endpoints may need no key; gate on base URL instead.
  if (opts.provider === 'openai') {
    if (!opts.baseUrl) {
      console.warn('[memory-upkeep] no base URL — skipping');
      return null;
    }
  } else if (!opts.apiKey) {
    console.warn('[memory-upkeep] no API key — skipping');
    return null;
  }

  // Frontmatter guard: split the memory note into its YAML frontmatter block
  // (Obsidian properties) and the plain-text body. Send ONLY the body to the
  // model so the model cannot alter or drop structured metadata. The original
  // frontmatter is re-attached verbatim to the proposed body before it is
  // surfaced to the user.
  const { frontmatter, body: memoryBodyOnly } = splitFrontmatter(opts.memoryBody);

  const exchange = buildExchangeText(opts.messages);
  const userPrompt =
    `Current memory note:\n<memory>\n${memoryBodyOnly || '(empty)'}\n</memory>\n\n` +
    `Recent conversation:\n${exchange}\n\nReturn the updated memory note:`;

  try {
    const res = await utilityComplete(opts.provider, opts.apiKey, opts.model, {
      system: UPKEEP_SYSTEM,
      userPrompt,
      maxTokens: UPKEEP_MAX_TOKENS,
      baseUrl: opts.baseUrl,
    });

    if (!res.ok || !res.text) {
      console.warn(`[memory-upkeep] provider returned ${res.status}`);
      return null;
    }

    const trimmedBody = res.text.trim();

    // No-op detection: compare NORMALIZED bodies so a cosmetically-different
    // response (reordered blank lines, whitespace, re-trimmed lines) that
    // carries no new facts is not surfaced as a spurious diff card.
    if (normalizeNoteBody(trimmedBody) === normalizeNoteBody(memoryBodyOnly)) {
      return null;
    }

    // Deletion guard: refuse to PROPOSE a destructive overwrite. If the
    // proposal drops more than UPKEEP_MAX_DELETION_FRACTION of the existing
    // note's non-whitespace content, treat it as suspect and skip silently
    // (warn for the operator). A non-technical user must never be shown a
    // mass-deletion overwrite to approve. Only guards against shrinkage of
    // a non-empty note — growth and first-population (empty → content) are
    // always allowed.
    const existingLen = nonWhitespaceLength(memoryBodyOnly);
    if (existingLen > 0) {
      const proposedLen = nonWhitespaceLength(trimmedBody);
      const dropped = existingLen - proposedLen;
      if (dropped > existingLen * UPKEEP_MAX_DELETION_FRACTION) {
        console.warn(
          `[memory-upkeep] proposal drops ${dropped}/${existingLen} non-whitespace chars ` +
            `(> ${UPKEEP_MAX_DELETION_FRACTION * 100}% threshold) — skipping as suspect destructive overwrite`,
        );
        return null;
      }
    }

    // Re-attach the original frontmatter verbatim so the full proposed note
    // (frontmatter + updated body) is what the diff card shows and what gets
    // written to the vault on approval.
    return frontmatter + trimmedBody;
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

/**
 * True when the turn counter indicates an upkeep pass is due.
 * Callers increment their counter after each finalized turn and check
 * this before calling proposeMemoryUpkeep.
 */
export function isUpkeepDue(turnsSinceUpkeep: number): boolean {
  return turnsSinceUpkeep >= UPKEEP_EVERY_N_TURNS;
}
