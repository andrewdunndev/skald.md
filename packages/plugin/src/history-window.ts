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
  if (total <= maxTokens) return messages.slice();

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

  return messages.slice(start);
}
