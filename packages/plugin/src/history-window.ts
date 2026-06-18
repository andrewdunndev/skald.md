/**
 * History windowing: truncate a conversation's Message[] to keep the
 * dispatched payload within a token budget before it is sent to the model.
 *
 * Token estimation: 1 token ≈ 4 chars (char-count proxy). The headroom
 * default is 150 000 tokens (~600 KB of chars). This is intentionally
 * generous — the purpose is to avoid multi-MB payloads from injected note
 * context, not to enforce a tight context window.
 *
 * Invariants preserved by the drop loop:
 *   1. The most recent user turn is always kept, even if it alone exceeds
 *      the budget (Anthropic requires the last message to be from the user).
 *   2. tool_use / tool_result pairs are kept or dropped atomically. An
 *      assistant message that ends with tool_use blocks is paired with the
 *      immediately following user message containing the tool_result blocks.
 *      Dropping half the pair would produce an Anthropic API error.
 *   3. The windowed slice never starts with a user message whose content
 *      begins with tool_result blocks — that means we dropped the matching
 *      assistant tool_use without dropping the tool_result response.
 */
import type { Message, ContentBlock } from '@scribian/protocol';

/** Characters per token (conservative proxy). */
const CHARS_PER_TOKEN = 4;

/** Default headroom in tokens. */
const DEFAULT_MAX_TOKENS = 150_000;

/**
 * Hard ceiling (estimated tokens) past which we warn. The windowing budget
 * is generous and Invariant 1 keeps the last user turn even if it alone
 * exceeds the budget — so a single giant turn can still blow past the model's
 * context limit and 400. This is a sanity log, not an enforcement: it never
 * drops the kept turn (that would break Invariant 1), it just surfaces the
 * likely cause in the console. 200k ≈ the current Claude context window.
 */
const CONTEXT_CEILING_TOKENS = 200_000;

/** Estimate the token cost of a single message. */
function estimateMessage(msg: Message): number {
  if (typeof msg.content === 'string') {
    return Math.ceil(msg.content.length / CHARS_PER_TOKEN);
  }
  let chars = 0;
  for (const block of msg.content) {
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string') chars += b.text.length;
    else if (typeof b.content === 'string') chars += b.content.length;
    else chars += JSON.stringify(block).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** True when the message contains at least one tool_result block, meaning
 * it is the user half of a tool_use/tool_result pair. */
function startsWithToolResult(msg: Message): boolean {
  if (typeof msg.content === 'string') return false;
  const first = msg.content[0] as Record<string, unknown> | undefined;
  return first?.type === 'tool_result';
}

/** True when the message is an assistant turn containing tool_use blocks. */
function containsToolUse(msg: Message): boolean {
  if (msg.role !== 'assistant') return false;
  if (typeof msg.content === 'string') return false;
  return (msg.content as ContentBlock[]).some(
    (b) => (b as Record<string, unknown>).type === 'tool_use',
  );
}

/**
 * Return a windowed copy of `messages` that fits within `maxTokens`.
 *
 * This.messages itself is never mutated — the caller keeps the full history
 * for UI display and conversation persistence. Only the slice sent to the
 * model is trimmed.
 *
 * @param messages - Full conversation history in chronological order.
 * @param maxTokens - Token budget (default DEFAULT_MAX_TOKENS).
 * @returns A new array that is a suffix of `messages`, trimmed from the
 *          front, satisfying all invariants listed in the file header.
 */
export function windowHistory(
  messages: Message[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Message[] {
  if (messages.length === 0) return [];

  // Compute per-message token estimates once.
  const costs = messages.map(estimateMessage);
  const total = costs.reduce((a, b) => a + b, 0);

  // Fast path: already within budget.
  if (total <= maxTokens) {
    warnIfOverCeiling(total);
    return messages.slice();
  }

  // Drop from the front until we are within budget.
  // We always keep at least the last message (the user's current turn).
  let start = 0;
  let running = total;

  while (start < messages.length - 1 && running > maxTokens) {
    running -= costs[start];
    start++;
  }

  // Invariant 3: if the new start is a tool_result-only user message, the
  // assistant tool_use that precedes it was dropped. Skip forward until we
  // find a clean boundary.
  while (start < messages.length - 1 && startsWithToolResult(messages[start])) {
    running -= costs[start];
    start++;
  }

  // Invariant 2: if the new start is an assistant message containing
  // tool_use, its paired tool_result user message immediately follows.
  // We must include the pair; if including both would re-exceed budget,
  // keep both anyway (we already hold at-least-last invariant).
  while (
    start < messages.length - 1 &&
    containsToolUse(messages[start])
  ) {
    // This assistant tool_use came in without its preceding user context —
    // skip both the tool_use and its tool_result response so we don't start
    // with a stranded tool_use.
    running -= costs[start];
    start++;
    // Also drop the paired tool_result user message if it immediately follows.
    if (start < messages.length - 1 && startsWithToolResult(messages[start])) {
      running -= costs[start];
      start++;
    }
  }

  // After trimming, the running estimate is the windowed payload size. If it
  // still exceeds the model context ceiling (a single oversized kept turn),
  // log a warning — Invariant 1 forbids dropping it, so this is the only
  // honest signal we can give before the request 400s.
  warnIfOverCeiling(running);

  return messages.slice(start);
}

/** Console-warn (once per call) when the estimated payload exceeds the
 * model context ceiling. Pure side-effect; never throws. */
function warnIfOverCeiling(estimatedTokens: number): void {
  if (estimatedTokens > CONTEXT_CEILING_TOKENS) {
    console.warn(
      `[scribian] windowed payload ≈${estimatedTokens} tokens exceeds the ` +
        `~${CONTEXT_CEILING_TOKENS}-token context ceiling; the request may be ` +
        `rejected. A single large note or turn is the likely cause.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Context compaction
// ---------------------------------------------------------------------------

/** Stub text injected for tool_result blocks older than keepRecentTurns. */
export const COMPACTION_STUB = '[earlier tool output omitted to save context]';

/** Default number of recent turns whose tool_results are kept verbatim. */
const DEFAULT_KEEP_RECENT_TURNS = 3;

/**
 * Size threshold (estimated tokens) below which compaction is a no-op.
 *
 * Why size-trigger compaction: incremental prompt-caching
 * (anthropic-caching.ts) places a moving breakpoint on the prior-turn
 * message, caching the whole prefix up to it. If compaction stubs a
 * newly-aged tool_result on EVERY turn, the cached prefix changes
 * nearly every turn → cache-CREATION is re-paid constantly and the two
 * features fight each other. Below this threshold the full history fits
 * comfortably, so we leave content verbatim → stable prefix → caching
 * works. Only once history is genuinely large does the token saving
 * from stubbing outweigh the lost cache reuse, and at that point the
 * old turns are stale anyway.
 *
 * 40 000 tokens (~160 KB at 4 chars/token) is well under the 150 000
 * windowing budget — compaction kicks in long before truncation does.
 */
export const COMPACTION_TOKEN_THRESHOLD = 40_000;

/** Estimated token cost of an entire message list (4-chars/token proxy,
 * matching windowHistory's estimator). */
function estimateTotal(messages: Message[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessage(m);
  return total;
}

/**
 * Replace the `content` of tool_result blocks in older turns with a
 * short stub, reducing the token cost of stale tool output that is
 * no longer needed verbatim but whose block must remain to keep the
 * tool_use / tool_result pairing intact.
 *
 * Size-triggered: when the estimated token cost of `messages` is below
 * `opts.tokenThreshold` (default COMPACTION_TOKEN_THRESHOLD), the input
 * is returned UNCHANGED so the cached prefix stays stable for
 * incremental prompt-caching. Stubbing only fires once history is large.
 *
 * Invariants preserved:
 *   - Every tool_use block retains its matching tool_result (now stubbed).
 *   - `tool_use_id` is never changed.
 *   - No blocks are added or removed.
 *   - Input `messages` is never mutated.
 *
 * A "turn" is a real-user-turn: a user message whose content is NOT
 * purely tool_result blocks. Tool-result user messages count as part
 * of the preceding assistant turn, not as independent turns.
 *
 * @param messages  Full (or windowed) message history.
 * @param opts.keepRecentTurns  Number of recent real-user-turns
 *   whose tool_results are kept verbatim (default 3).
 * @param opts.tokenThreshold  Estimated-token floor below which
 *   compaction is skipped entirely (default COMPACTION_TOKEN_THRESHOLD).
 * @returns A new array with stale tool_result content replaced, or a
 *   verbatim copy when below the threshold.
 */
export function compactStaleToolResults(
  messages: Message[],
  opts?: { keepRecentTurns?: number; tokenThreshold?: number },
): Message[] {
  const keepTurns = opts?.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const threshold = opts?.tokenThreshold ?? COMPACTION_TOKEN_THRESHOLD;

  // Below the threshold: leave content verbatim so the prompt-cache
  // prefix stays stable turn-to-turn (see COMPACTION_TOKEN_THRESHOLD).
  if (estimateTotal(messages) < threshold) return messages.slice();

  // Walk backwards to find the start index of the "keep" window.
  // Each real-user-turn consumed while walking back counts as one turn.
  // Stop when we've counted keepTurns turns — everything from that point
  // forward is in the window; everything before is "stale".
  let turnsRemaining = keepTurns;
  let keepFromIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !startsWithToolResult(m)) {
      turnsRemaining--;
      if (turnsRemaining < 0) {
        // We've passed keepTurns real-user turns going back; this turn
        // is beyond the keep window so the window starts just after it.
        keepFromIndex = i + 1;
        break;
      }
    }
  }

  return messages.map((msg, idx) => {
    if (idx >= keepFromIndex) return msg;

    // Only compact user messages containing tool_result blocks.
    if (msg.role !== 'user') return msg;
    if (typeof msg.content === 'string') return msg;
    const blocks = msg.content as ContentBlock[];
    if (!blocks.some((b) => (b as Record<string, unknown>).type === 'tool_result')) {
      return msg;
    }

    // Replace tool_result content with the stub; preserve type, tool_use_id,
    // and is_error so the tool_use/tool_result pairing remains intact.
    const compacted = blocks.map((b) => {
      const block = b as Record<string, unknown>;
      if (block.type !== 'tool_result') return b;
      return { ...block, content: COMPACTION_STUB } as ContentBlock;
    });

    return { ...msg, content: compacted };
  });
}
