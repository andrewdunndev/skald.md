/**
 * Content-block renderer — dispatches on Anthropic-canonical content
 * block types to per-type DOM construction. Text + thinking + image
 * + tool_use + tool_result + web_search_tool_result +
 * web_fetch_tool_result + server_tool_use are all here; unknown
 * types render a friendly placeholder instead of dumping JSON.
 *
 * Extracted from view.ts as part of the LOC-cap refactor. The
 * dispatcher is the biggest single function in the codebase; it
 * has a clear single responsibility (DOM from blocks) so it lives
 * alone here. The host view provides the BlockContext bundle so
 * this module doesn't reach back into ScribianView state.
 *
 * Vacuity note: the renderer's behavior is exercised through the
 * Obsidian runtime — pure unit tests can cover the helpers
 * (describeToolUse / describeToolResult) but the DOM-painting paths
 * need an integration harness. Helpers are tested at the bottom of
 * this folder's intent: small pure functions are testable, the
 * dispatcher is reviewable.
 */

import { MarkdownRenderer, type App, type Component } from 'obsidian';
import type { ContentBlock } from '@scribian/protocol';
import { renderDiffCard } from './diff-card';
import type { WriteProposal } from '../tools';
import { citationLabel, citationPath, type CitationLocation } from '../citations';

export interface BlockContext {
  app: App;
  component: Component;
  /** Lookup for the tool_use case: is this id awaiting approval?
   * Returns the proposal so the renderer can paint the diff card. */
  pendingApproval: (toolUseId: string) => WriteProposal | null;
  onApprove: (toolUseId: string) => void;
  onReject: (toolUseId: string) => void;
  /**
   * Optional: map from Anthropic document_index → vault path. When
   * provided, text blocks with `citations` arrays render inline
   * superscript markers (e.g. [1]) that link to the source note.
   * Absent → citation markers are omitted (non-Anthropic path).
   */
  documentRegistry?: ReadonlyMap<number, string>;
}

export async function renderBlock(
  parent: HTMLElement,
  block: ContentBlock,
  ctx: BlockContext,
): Promise<void> {
  const b = block as Record<string, unknown>;
  const type = b.type as string | undefined;

  if (type === 'text') {
    const text = (b.text as string) ?? '';
    if (!text) return;
    const wrap = parent.createDiv({ cls: 'scribian-text' });
    await renderMarkdownInto(wrap, text, ctx);
    // Citations path: if this text block carries citation objects (returned
    // by the Anthropic Citations API) and we have a document registry,
    // append inline superscript markers that link back to the source note.
    const citations = b.citations as CitationLocation[] | undefined;
    if (
      Array.isArray(citations) &&
      citations.length > 0 &&
      ctx.documentRegistry
    ) {
      renderCitationMarkers(wrap, citations, ctx.documentRegistry, ctx.app);
    }
    return;
  }

  if (type === 'thinking') {
    const t = parent.createDiv({ cls: 'scribian-thinking' });
    t.createSpan({ cls: 'scribian-thinking-icon', text: '💭' });
    t.createSpan({ text: (b.thinking as string) ?? '' });
    return;
  }

  if (type === 'image') {
    renderImageBlock(parent, b);
    return;
  }

  if (type === 'tool_use') {
    const id = b.id as string | undefined;
    const name = (b.name as string) ?? 'tool';
    const input = b.input ?? b.partial_json;
    const row = parent.createDiv({ cls: 'scribian-tool-call' });
    row.createSpan({
      cls: 'scribian-tool-name',
      text: describeToolUse(name, input),
    });
    const pending = id ? ctx.pendingApproval(id) : null;
    if (pending) {
      renderDiffCard(parent, pending, {
        onApprove: ctx.onApprove,
        onReject: ctx.onReject,
      });
    }
    return;
  }

  if (type === 'tool_result') {
    await renderToolResult(parent, b, ctx);
    return;
  }

  if (type === 'web_search_tool_result') {
    await renderWebSearchResult(parent, b, ctx);
    return;
  }

  if (type === 'web_fetch_tool_result') {
    await renderWebFetchResult(parent, b, ctx);
    return;
  }

  if (type === 'server_tool_use') {
    const name = (b.name as string) ?? 'server_tool';
    const row = parent.createDiv({ cls: 'scribian-tool-call' });
    row.createSpan({
      cls: 'scribian-tool-name',
      text: describeToolUse(name, b.input),
    });
    return;
  }

  // Unknown block type — friendly placeholder instead of JSON dump.
  // Non-developer users find JSON in chat jarring; developers can
  // drop to the console.
  const placeholder = parent.createDiv({ cls: 'scribian-unknown-block' });
  placeholder.createSpan({ text: `(unhandled block: ${type ?? 'unknown'})` });
}

/**
 * Render markdown into a container using Obsidian's
 * MarkdownRenderer. sourcePath empty so `[[Note]]` resolves from
 * the vault root (the user's mental model of "Claude references
 * my notes"). The markdown-rendered class scopes Obsidian's
 * reading-view CSS so tables get borders, callouts get
 * backgrounds, etc.
 */
export async function renderMarkdownInto(
  el: HTMLElement,
  md: string,
  ctx: Pick<BlockContext, 'app' | 'component'>,
): Promise<void> {
  el.addClass('markdown-rendered');
  await MarkdownRenderer.render(ctx.app, md, el, '', ctx.component);
}

// ── per-block helpers ──────────────────────────────────────────

function renderImageBlock(
  parent: HTMLElement,
  b: Record<string, unknown>,
): void {
  const source = b.source as Record<string, unknown> | undefined;
  if (!source) return;
  const figure = parent.createDiv({ cls: 'scribian-image' });
  const img = figure.createEl('img', { cls: 'scribian-image-thumb' });
  if (source.type === 'base64') {
    const media = String(source.media_type ?? 'image/png');
    const data = String(source.data ?? '');
    img.src = `data:${media};base64,${data}`;
  } else if (source.type === 'url') {
    img.src = String((source as { url?: unknown }).url ?? '');
  }
  img.alt = 'attached image';
}

async function renderToolResult(
  parent: HTMLElement,
  b: Record<string, unknown>,
  ctx: BlockContext,
): Promise<void> {
  const isError = b.is_error === true;
  const content = b.content;
  const hasStringContent =
    typeof content === 'string' && content.length > 0;
  if (!hasStringContent) {
    const row = parent.createDiv({
      cls: `scribian-tool-result-row${isError ? ' scribian-tool-result-error' : ''}`,
    });
    row.createSpan({
      cls: 'scribian-tool-result-label',
      text: describeToolResult(content, isError),
    });
    return;
  }
  const card = parent.createEl('details', {
    cls: `scribian-tool-result${isError ? ' scribian-tool-result-error' : ''}`,
  });
  const summary = card.createEl('summary', {
    cls: 'scribian-tool-summary',
  });
  summary.createSpan({
    cls: 'scribian-tool-result-label',
    text: describeToolResult(content, isError),
  });
  const body = card.createDiv({ cls: 'scribian-tool-result-body' });
  await renderMarkdownInto(body, content as string, ctx);
}

async function renderWebSearchResult(
  parent: HTMLElement,
  b: Record<string, unknown>,
  ctx: BlockContext,
): Promise<void> {
  const card = parent.createEl('details', {
    cls: 'scribian-tool-result scribian-tool-web',
  });
  const summary = card.createEl('summary', { cls: 'scribian-tool-summary' });
  const content = b.content;
  const hitCount = Array.isArray(content) ? content.length : 0;
  summary.createSpan({
    cls: 'scribian-tool-result-label',
    text: `🌐 ${hitCount} web result${hitCount === 1 ? '' : 's'}`,
  });
  const body = card.createDiv({ cls: 'scribian-tool-result-body' });
  if (Array.isArray(content)) {
    const md = content
      .map((entry: Record<string, unknown>) => {
        if (entry?.type === 'web_search_result') {
          const title = entry.title ?? entry.url ?? 'result';
          const url = (entry.url as string | undefined) ?? '';
          const age = entry.page_age ? ` · ${entry.page_age}` : '';
          return `- [${title}](${url})${age}`;
        }
        return `- ${entry?.title ?? entry?.url ?? '(unknown result)'}`;
      })
      .join('\n');
    await renderMarkdownInto(body, md, ctx);
  } else {
    body.createSpan({ text: '(no results)' });
  }
}

async function renderWebFetchResult(
  parent: HTMLElement,
  b: Record<string, unknown>,
  ctx: BlockContext,
): Promise<void> {
  const content = b.content as Record<string, unknown> | undefined;
  const card = parent.createEl('details', {
    cls: 'scribian-tool-result scribian-tool-web',
  });
  const summary = card.createEl('summary', { cls: 'scribian-tool-summary' });
  const url = content?.url as string | undefined;
  summary.createSpan({
    cls: 'scribian-tool-result-label',
    text: url ? `🌐 Fetched ${url}` : '🌐 Fetched',
  });
  const body = card.createDiv({ cls: 'scribian-tool-result-body' });
  // web_fetch returns content as either a document object with
  // extracted markdown, or an array of content blocks. Surface the
  // text; never dump JSON.
  const inner = content?.content;
  if (typeof inner === 'string') {
    await renderMarkdownInto(body, inner, ctx);
    return;
  }
  if (Array.isArray(inner)) {
    for (const entry of inner) {
      if (entry?.type === 'text' && typeof entry.text === 'string') {
        await renderMarkdownInto(body, entry.text, ctx);
      }
    }
    return;
  }
  if (inner && typeof inner === 'object') {
    const doc = inner as Record<string, unknown>;
    const text =
      (doc.text as string | undefined) ??
      ((doc.source as Record<string, unknown> | undefined)?.data as
        | string
        | undefined);
    if (text) {
      await renderMarkdownInto(body, text, ctx);
    } else {
      body.createSpan({ text: '(fetched, but no text content surfaced)' });
    }
    return;
  }
  body.createSpan({ text: '(empty fetch)' });
}

/**
 * Human-readable label for a tool_use. Single-line summary that
 * fits in the collapsed-tool-call row; raw JSON args don't appear
 * to non-developers.
 */
export function describeToolUse(name: string, input: unknown): string {
  const i = (input as Record<string, any>) ?? {};
  switch (name) {
    case 'read_note':
      return `📖 Reading ${i.path ?? '?'}`;
    case 'list_notes': {
      const where = i.folder ? ` in \`${i.folder}\`` : '';
      const limit = i.limit ? ` (limit ${i.limit})` : '';
      return `📋 Listing notes${where}${limit}`;
    }
    case 'search_vault':
      return `🔍 Searching vault for "${i.query ?? '?'}"`;
    case 'current_note':
      return `📍 Reading the current note`;
    case 'metadata':
      return `ℹ️ Metadata for ${i.path ?? '?'}`;
    case 'find_related':
      return `🧭 Finding notes related to "${i.query ?? '?'}"`;
    case 'web_search':
      return `🌐 Web search: "${i.query ?? '?'}"`;
    case 'web_fetch':
      return `🌐 Fetching ${i.url ?? '?'}`;
    case 'write_note':
      return `✏️ Write ${i.path ?? '?'}`;
    case 'edit_note':
      return `✏️ Edit ${i.path ?? '?'}`;
    case 'append_to_note':
      return `➕ Append to ${i.path ?? '?'}`;
    default:
      return `🔧 ${name}`;
  }
}

/**
 * Render inline citation superscripts for a text block that has
 * Anthropic Citations API `citations` data. Each unique document_index
 * in the citation list gets a compact `[N]` superscript that is
 * clickable to open the source vault note.
 *
 * We dedupe by document_index within the block — multiple citations to
 * the same document show only one marker — and sort by index so the
 * order is deterministic.
 */
function renderCitationMarkers(
  parent: HTMLElement,
  citations: CitationLocation[],
  registry: ReadonlyMap<number, string>,
  app: App,
): void {
  // Dedupe by document_index within this block, preserving first occurrence.
  const seen = new Set<number>();
  const unique = citations.filter((c) => {
    if (seen.has(c.document_index)) return false;
    seen.add(c.document_index);
    return true;
  });
  if (unique.length === 0) return;

  const sup = parent.createEl('sup', { cls: 'scribian-citations' });
  unique.forEach((citation, i) => {
    if (i > 0) sup.createSpan({ text: ' ' }); // thin nbsp separator
    const path = citationPath(registry, citation);
    const label = citationLabel(citation.document_index);
    if (path) {
      const a = sup.createEl('a', {
        cls: 'internal-link scribian-citation-link',
        text: label,
        attr: {
          'data-href': path,
          href: path,
          title: `Source: ${path}`,
        },
      });
      a.addEventListener('click', (e) => {
        e.preventDefault();
        void app.workspace.openLinkText(path, '', false);
      });
    } else {
      sup.createSpan({ text: label });
    }
  });
}

/**
 * Single-line summary of a tool_result content string. The full
 * content lives inside the collapsible card; this is the
 * "preview" line that shows on the closed card.
 */
export function describeToolResult(
  content: unknown,
  isError: boolean,
): string {
  if (isError) return '⚠️ tool error';
  if (typeof content === 'string') {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length === 0) return '✓ result (empty)';
    if (firstLine.length > 80) return `✓ ${firstLine.slice(0, 77)}…`;
    const more = content.includes('\n') ? ' …' : '';
    return `✓ ${firstLine}${more}`;
  }
  return '✓ tool result';
}
