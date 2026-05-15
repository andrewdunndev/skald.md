import { App, normalizePath, TFile } from 'obsidian';
import type { Message, Usage } from '@scribian/protocol';

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
function slugify(text: string, max = 40): string {
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
function stripContext(text: string): { text: string; attachedPaths: string[] } {
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
  lines.push(`scribian-conversation-id: ${meta.id}`);
  lines.push(`scribian-model: ${meta.model}`);
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
        lines.push(clean || '(empty message)');
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
            lines.push(clean || '(empty message)');
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
        lines.push(m.content);
        lines.push('');
      } else {
        for (const block of m.content) {
          const b = block as Record<string, any>;
          const t = b.type as string;
          if (t === 'text' && typeof b.text === 'string') {
            lines.push(b.text);
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

  return lines.join('\n');
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

/**
 * Save (or update) the conversation file in the configured chats folder.
 * Filename uses the conversation id so subsequent updates rewrite the
 * same file. Folder is auto-created.
 */
export async function saveConversation(
  app: App,
  folder: string,
  meta: ConversationMeta,
  messages: Message[],
): Promise<TFile | null> {
  if (!folder.trim()) return null;
  if (messages.length === 0) return null;

  const normalizedFolder = normalizePath(folder);
  const folderItem = app.vault.getAbstractFileByPath(normalizedFolder);
  if (!folderItem) {
    try {
      await app.vault.createFolder(normalizedFolder);
    } catch {
      // race / already exists; ignore
    }
  }

  const firstUser = messages.find((m) => m.role === 'user');
  const seed =
    firstUser && typeof firstUser.content === 'string'
      ? stripContext(firstUser.content).text
      : 'chat';
  const datePart = meta.created.slice(0, 10);
  const slug = slugify(seed);
  const filename = `${datePart}-${slug}-${meta.id.slice(0, 6)}.md`;
  const path = normalizePath(`${normalizedFolder}/${filename}`);

  // Final guard against any traversal that slipped past slugify:
  // the resolved path MUST live inside the configured folder.
  if (!path.startsWith(`${normalizedFolder}/`)) {
    console.error(
      `scribian: refusing to save outside folder (resolved="${path}" folder="${normalizedFolder}")`,
    );
    return null;
  }

  const body = renderConversationMarkdown(meta, messages);
  const existing = app.vault.getAbstractFileByPath(path);
  try {
    if (existing instanceof TFile) {
      await app.vault.modify(existing, body);
      return existing;
    }
    return await app.vault.create(path, body);
  } catch (err) {
    console.error('scribian: saveConversation failed', err);
    return null;
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
