import type { Message, Usage } from './protocol';
import { neutralizeRemoteMedia, restoreRemoteMedia } from './remote-media';

export interface ConversationMeta {
  id: string;
  model: string;
  created: string; // ISO 8601
  updated: string; // ISO 8601
  /** Cumulative usage across every finalized turn in the
   * conversation. Optional — omitted from frontmatter when absent
   * (e.g. for legacy saves). */
  usage?: Usage;
  /** Estimated USD cost based on per-model pricing. Surfaced as
   * `estimated_cost_usd` in the saved frontmatter. */
  costUSD?: number;
}

/**
 * Generates a vault-safe slug from the first user message. Used to build
 * a human-browseable filename. Falls back to the conversation id if the
 * message has nothing slug-worthy.
 */
export function slugify(text: string, max = 40): string {
  const cleaned = text
    .toLowerCase()
    .replace(/<context>[\s\S]*?<\/context>/g, '')
    // Allow only letters, numbers, hyphen, whitespace. Any `.` is
    // dropped which incidentally blocks `..` traversal attempts in
    // the resulting filename; the safety net below catches anything
    // that slipped through.
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Defense in depth: never let `..` or path separators survive,
  // even though our character whitelist should have caught them.
  const safe = cleaned.replace(/\.\.+/g, '').replace(/[\\/]/g, '');
  return safe.slice(0, max) || 'chat';
}

/**
 * Strip the <context>…</context> XML wrapper from a user message so the
 * saved file shows the question, not the embedded note bodies.
 */
export function stripContext(text: string): { text: string; attachedPaths: string[] } {
  const ctxMatch = text.match(/<context>([\s\S]*?)<\/context>\s*([\s\S]*)$/);
  if (!ctxMatch) return { text, attachedPaths: [] };
  const ctxBody = ctxMatch[1];
  const rest = ctxMatch[2].trim();
  const paths: string[] = [];
  for (const m of ctxBody.matchAll(/<file[^>]*path="([^"]+)"/g)) {
    paths.push(m[1]);
  }
  return { text: rest, attachedPaths: paths };
}

/**
 * Render the conversation as readable markdown. Tool calls + results
 * compress to one-liners; embedded context strips down to a footer
 * note. The frontmatter holds machine-readable metadata.
 */
export function renderConversationMarkdown(
  meta: ConversationMeta,
  messages: Message[],
): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`skald-conversation-id: ${meta.id}`);
  lines.push(`skald-model: ${meta.model}`);
  lines.push(`created: ${meta.created}`);
  lines.push(`updated: ${meta.updated}`);
  if (meta.usage) {
    lines.push(`input_tokens: ${meta.usage.input_tokens ?? 0}`);
    lines.push(`output_tokens: ${meta.usage.output_tokens ?? 0}`);
    if (meta.usage.cache_read_input_tokens) {
      lines.push(
        `cache_read_input_tokens: ${meta.usage.cache_read_input_tokens}`,
      );
    }
    if (meta.usage.cache_creation_input_tokens) {
      lines.push(
        `cache_creation_input_tokens: ${meta.usage.cache_creation_input_tokens}`,
      );
    }
  }
  if (typeof meta.costUSD === 'number' && meta.costUSD > 0) {
    // Six decimals: sub-cent precision matters on mobile-burst
    // flows where one chat may be a few thousandths of a dollar.
    lines.push(`estimated_cost_usd: ${meta.costUSD.toFixed(6)}`);
  }
  lines.push('---');
  lines.push('');

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      lines.push('## You');
      lines.push('');
      if (typeof m.content === 'string') {
        const { text: clean, attachedPaths } = stripContext(m.content);
        if (attachedPaths.length > 0) {
          lines.push(attachedPaths.map((p) => `> 📎 [[${p}]]`).join('\n'));
          lines.push('');
        }
        lines.push(escapeTurnHeadings(clean) || '(empty message)');
        lines.push('');
      } else {
        // Multi-modal user turn (text + images). Render text blocks
        // as prose; images get a placeholder so saved files stay
        // readable (the in-memory ChatSession still holds the full
        // base64 payload for any model continuation).
        for (const block of m.content) {
          const b = block as Record<string, any>;
          if (b.type === 'text' && typeof b.text === 'string') {
            const { text: clean, attachedPaths } = stripContext(b.text);
            if (attachedPaths.length > 0) {
              lines.push(
                attachedPaths.map((p) => `> 📎 [[${p}]]`).join('\n'),
              );
              lines.push('');
            }
            lines.push(escapeTurnHeadings(clean) || '(empty message)');
            lines.push('');
          } else if (b.type === 'image') {
            const source = b.source as Record<string, unknown> | undefined;
            const mt =
              source && typeof source.media_type === 'string'
                ? source.media_type
                : 'image';
            lines.push(`> 🖼 _attached ${mt} (omitted from saved record)_`);
            lines.push('');
          }
        }
      }
    } else if (m.role === 'assistant') {
      lines.push('## Claude');
      lines.push('');
      if (typeof m.content === 'string') {
        lines.push(escapeTurnHeadings(m.content));
        lines.push('');
      } else {
        for (const block of m.content) {
          const b = block as Record<string, any>;
          const t = b.type as string;
          if (t === 'text' && typeof b.text === 'string') {
            lines.push(escapeTurnHeadings(b.text));
            lines.push('');
          } else if (t === 'thinking' && typeof b.thinking === 'string') {
            // Hide thinking in saved output by default. Comment out the
            // next two lines to include it.
            // lines.push(`> _Thinking:_ ${b.thinking}`);
            // lines.push('');
          } else if (t === 'tool_use') {
            lines.push(`> 🔧 _${describeBlock(b)}_`);
            lines.push('');
          } else if (t === 'server_tool_use') {
            lines.push(`> 🌐 _${describeBlock(b)}_`);
            lines.push('');
          } else if (t === 'tool_result' && typeof b.content === 'string') {
            const isError = b.is_error === true;
            const head = isError ? '⚠️ tool error' : '✓ tool result';
            const summary = (b.content as string).split('\n')[0].slice(0, 80);
            lines.push(`> ${head}: ${summary}`);
            lines.push('');
          } else if (t === 'web_search_tool_result') {
            const arr = Array.isArray(b.content) ? b.content : [];
            lines.push(`> 🌐 web search returned ${arr.length} results`);
            lines.push('');
          } else if (t === 'image') {
            // Phase 7: don't dump base64 image payloads into the
            // conversation file. Record a placeholder so the saved
            // turn remains readable; the in-memory ChatSession still
            // holds the full block for any continuation Claude sends.
            const source = b.source as Record<string, unknown> | undefined;
            const mt = source && typeof source.media_type === 'string'
              ? source.media_type
              : 'image';
            lines.push(`> 🖼 _attached ${mt} (omitted from saved record)_`);
            lines.push('');
          }
        }
      }
    }
  }

  // The saved note renders in Obsidian like any other: keep a remote
  // image the model wrote from loading when it is opened.
  return neutralizeRemoteMedia(lines.join('\n'));
}

// A body line that reads as a turn heading would split into a forged
// turn on resume. Escaping adds one backslash (markdown shows the line
// as literal text); parsing removes one, so every line round-trips.
const TURN_HEADING_LINE = /^(\\*## (?:You|Claude)[^\S\n]*)$/gm;
const ESCAPED_TURN_HEADING_LINE = /^\\(\\*## (?:You|Claude)[^\S\n]*)$/gm;

function escapeTurnHeadings(text: string): string {
  return text.replace(TURN_HEADING_LINE, '\\$1');
}

function unescapeTurnHeadings(text: string): string {
  return text.replace(ESCAPED_TURN_HEADING_LINE, '$1');
}

function describeBlock(b: Record<string, any>): string {
  const name = b.name as string | undefined;
  const input = (b.input as Record<string, any>) ?? {};
  switch (name) {
    case 'read_note':
      return `Reading ${input.path ?? '?'}`;
    case 'list_notes':
      return `Listing notes${input.folder ? ` in ${input.folder}` : ''}`;
    case 'search_vault':
      return `Searching vault for "${input.query ?? '?'}"`;
    case 'current_note':
      return 'Reading the current note';
    case 'metadata':
      return `Metadata for ${input.path ?? '?'}`;
    case 'web_search':
      return `Web search: "${input.query ?? '?'}"`;
    case 'web_fetch':
      return `Fetching ${input.url ?? '?'}`;
    case 'write_note':
      return `Write ${input.path ?? '?'}`;
    case 'edit_note':
      return `Edit ${input.path ?? '?'}`;
    case 'append_to_note':
      return `Append to ${input.path ?? '?'}`;
    default:
      return name ?? 'tool call';
  }
}

/** Wire up a UUID for a fresh conversation. */
export function newConversationMeta(model: string): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    model,
    created: now,
    updated: now,
  };
}

/**
 * Parse a saved conversation markdown file back into structured data.
 * Inverse of renderConversationMarkdown. Tolerant of missing fields
 * and user edits — returns null rather than throwing.
 */
export function parseConversationMarkdown(
  content: string,
): { meta: Partial<ConversationMeta>; messages: Message[] } | null {
  try {
    // Extract frontmatter between the leading --- delimiters.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];

    const id = fmValue(fm, 'skald-conversation-id');
    if (!id) return null; // no id = not a skald conversation

    const model = fmValue(fm, 'skald-model') ?? undefined;
    const created = fmValue(fm, 'created') ?? undefined;
    const updated = fmValue(fm, 'updated') ?? undefined;

    const inputTokens = fmInt(fm, 'input_tokens');
    const outputTokens = fmInt(fm, 'output_tokens');
    const cacheRead = fmInt(fm, 'cache_read_input_tokens');
    const cacheWrite = fmInt(fm, 'cache_creation_input_tokens');
    const costUSD = fmFloat(fm, 'estimated_cost_usd');

    const usage: Usage | undefined =
      inputTokens !== undefined || outputTokens !== undefined
        ? {
            input_tokens: inputTokens ?? 0,
            output_tokens: outputTokens ?? 0,
            ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
            ...(cacheWrite
              ? { cache_creation_input_tokens: cacheWrite }
              : {}),
          }
        : undefined;

    const meta: Partial<ConversationMeta> = { id };
    if (model) meta.model = model;
    if (created) meta.created = created;
    if (updated) meta.updated = updated;
    if (usage) meta.usage = usage;
    if (costUSD !== undefined && costUSD > 0) meta.costUSD = costUSD;

    // Strip frontmatter to get the body.
    const body = restoreRemoteMedia(content.slice(fmMatch[0].length));

    // Split on ## You / ## Claude headings.
    const sectionRe = /^## (You|Claude)\s*$/m;
    const parts = body.split(sectionRe);
    // parts[0] = pre-first-heading text (ignored)
    // parts[1,3,5,...] = role strings ('You' / 'Claude')
    // parts[2,4,6,...] = section bodies

    const messages: Message[] = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const roleLabel = parts[i].trim();
      const sectionText = parts[i + 1];
      const role: 'user' | 'assistant' =
        roleLabel === 'You' ? 'user' : 'assistant';
      const cleaned = unescapeTurnHeadings(stripDisplayArtifacts(sectionText));
      if (!cleaned) continue; // drop empty sections
      messages.push({ role, content: cleaned });
    }

    if (messages.length === 0) return null;
    return { meta, messages };
  } catch {
    return null;
  }
}

/** Strip display-only blockquote artifacts from a section body. */
function stripDisplayArtifacts(text: string): string {
  // Drop any line that is a skald-emitted blockquote decoration.
  const ARTIFACT = /^> (📎 \[\[|🖼 |🔧 |🌐 |⚠️ tool error|✓ tool result)/;
  return text
    .split('\n')
    .filter((l) => !ARTIFACT.test(l))
    .join('\n')
    .trim();
}

function fmValue(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${escapeRe(key)}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function fmInt(fm: string, key: string): number | undefined {
  const v = fmValue(fm, key);
  if (v === null) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function fmFloat(fm: string, key: string): number | undefined {
  const v = fmValue(fm, key);
  if (v === null) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
