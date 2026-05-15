import {
  App,
  Component,
  MarkdownRenderer,
  setIcon,
  type ItemView,
} from 'obsidian';
import type { Message } from '@scribian/protocol';
import { renderBlock, type BlockContext } from './block-renderer';
import { renderMessageActions } from './message-actions';
import { renderEmptyState, type StarterChip } from './empty-state';
import type { WriteProposal } from '../tools';

const RENDER_THROTTLE_MS = 150;

interface MessageRow {
  el: HTMLDivElement;
  body: HTMLDivElement;
  component: Component;
  finalized: boolean;
}

export interface MessageListContext {
  app: App;
  /** The ItemView the list is hosted in. Needed for addChild/removeChild
   * so child Components are lifecycle-managed by Obsidian. */
  host: ItemView;
  /** Returns the pending WriteProposal for a tool_use_id, or null if
   * none is currently awaiting approval. The list uses this to render
   * approval cards inline. */
  pendingApproval: (id: string) => WriteProposal | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  /** Where finalized assistant messages can be saved to from the
   * "Save as new note" / "Append to current note" action row. */
  savedNotesFolder: string;
  /** Called when the user taps a starter chip in the empty state.
   * The host fills the composer with the chip's prompt — the user
   * reviews + sends in the normal flow. */
  onStarterPick: (prompt: string) => void;
  /** Optional override for the empty-state starter chips. Defaults
   * to DEFAULT_STARTER_CHIPS from view/empty-state.ts. */
  starterChips?: StarterChip[];
}

/**
 * Streaming chat message list. Owns the scrollable messages
 * container; rebuilds rows incrementally as the chat session emits
 * updates. ScribianView calls requestRender() on every update; the
 * list batches with a 150ms throttle before walking the diff between
 * its current row count + the session's history.
 */
export class MessageList {
  private readonly messagesEl: HTMLDivElement;
  private readonly ctx: MessageListContext;
  private rows: MessageRow[] = [];
  private renderTimer: number | null = null;
  private emptyStateEl: HTMLDivElement | null = null;

  constructor(parent: HTMLElement, ctx: MessageListContext) {
    this.ctx = ctx;
    this.messagesEl = parent.createDiv({ cls: 'scribian-messages' });
    this.renderEmptyState();
  }

  private renderEmptyState(): void {
    this.emptyStateEl?.remove();
    this.emptyStateEl = renderEmptyState(
      this.messagesEl,
      { onChipPick: (prompt) => this.ctx.onStarterPick(prompt) },
      this.ctx.starterChips,
    );
  }

  private clearEmptyState(): void {
    this.emptyStateEl?.remove();
    this.emptyStateEl = null;
  }

  el(): HTMLDivElement {
    return this.messagesEl;
  }

  /** Schedule a render. Coalesces multiple updates within the throttle
   * window so streaming SSE chunks don't trigger a render per delta. */
  requestRender(
    history: Message[],
    inFlight: { blocks: Message['content'] } | null,
  ): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.flushRender(history, inFlight);
    }, RENDER_THROTTLE_MS);
  }

  /** Immediate render — used for finalizing a turn (after onDone) so
   * the assistant message stops streaming and locks its rendered DOM. */
  async flushRender(
    history: Message[],
    inFlight: { blocks: Message['content'] } | null,
  ): Promise<void> {
    const totalCount = history.length + (inFlight ? 1 : 0);

    if (totalCount === 0) {
      // No messages — render (or keep) the empty-state welcome.
      if (!this.emptyStateEl) this.renderEmptyState();
    } else {
      // First message arriving clears the welcome.
      this.clearEmptyState();
    }

    while (this.rows.length < totalCount) {
      this.appendRow();
    }
    while (this.rows.length > totalCount) {
      this.popRow();
    }

    for (let i = 0; i < totalCount; i++) {
      const isInFlight = i >= history.length;
      const msg: Message = isInFlight
        ? { role: 'assistant', content: inFlight!.blocks }
        : history[i];
      const row = this.rows[i];
      // Toggle the streaming class so CSS can animate the in-flight row.
      row.el.toggleClass('scribian-msg-streaming', isInFlight);
      if (row.finalized && !isInFlight) continue;
      await this.renderRow(row, msg, isInFlight);
      if (!isInFlight) row.finalized = true;
    }

    // Smooth scroll to the latest content. Falls back to instant on
    // engines that don't support the scrollTo options bag (older
    // mobile webviews) — scrollTop assignment is the safe baseline.
    if (typeof this.messagesEl.scrollTo === 'function') {
      this.messagesEl.scrollTo({
        top: this.messagesEl.scrollHeight,
        behavior: 'smooth',
      });
    } else {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  cancelPendingRender(): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  /** Tear down every row and clear the messages container — invoked
   * on new chat / disconnect. Restores the empty-state welcome
   * since the user is now staring at an empty pane. */
  tearDown(): void {
    while (this.rows.length > 0) this.popRow();
    this.messagesEl.empty();
    this.emptyStateEl = null;
    this.renderEmptyState();
  }

  /** DOM query helper for approval card removal (the diff card lives
   * inside a finalized row, so the message list's re-render won't
   * touch it; the approval flow patches the DOM in place). */
  queryDiff(toolUseId: string): Element | null {
    return this.messagesEl.querySelector(
      `.scribian-diff[data-tool-use-id="${escapeCss(toolUseId)}"]`,
    );
  }

  private appendRow(): void {
    const el = this.messagesEl.createDiv({ cls: 'scribian-msg' });
    el.createSpan({ cls: 'scribian-msg-who' });
    const body = el.createDiv({ cls: 'scribian-msg-body' });
    const component = new Component();
    this.ctx.host.addChild(component);
    this.rows.push({ el, body, component, finalized: false });
  }

  private popRow(): void {
    const row = this.rows.pop();
    if (!row) return;
    row.component.unload();
    this.ctx.host.removeChild(row.component);
    row.el.remove();
  }

  private async renderRow(
    row: MessageRow,
    msg: Message,
    isInFlight: boolean,
  ): Promise<void> {
    row.el.removeClass('scribian-msg-user', 'scribian-msg-assistant');
    row.el.addClass(`scribian-msg-${msg.role}`);

    const whoEl = row.el.querySelector(
      '.scribian-msg-who',
    ) as HTMLElement | null;
    if (whoEl) {
      whoEl.empty();
      const avatar = whoEl.createSpan({ cls: 'scribian-msg-avatar' });
      setIcon(avatar, msg.role === 'user' ? 'user' : 'sparkles');
      whoEl.createSpan({
        cls: 'scribian-msg-label',
        text: msg.role === 'user' ? 'You' : 'Claude',
      });
    }

    // Replace the component so previous renders' subscribers are unloaded.
    row.component.unload();
    this.ctx.host.removeChild(row.component);
    row.component = new Component();
    this.ctx.host.addChild(row.component);

    row.body.empty();

    const blockCtx: BlockContext = {
      app: this.ctx.app,
      component: row.component,
      pendingApproval: (id) => this.ctx.pendingApproval(id),
      onApprove: (id) => this.ctx.onApprove(id),
      onReject: (id) => this.ctx.onReject(id),
    };

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        const wrap = row.body.createDiv({ cls: 'scribian-text' });
        wrap.addClass('markdown-rendered');
        await MarkdownRenderer.render(
          this.ctx.app,
          msg.content,
          wrap,
          '',
          row.component,
        );
      } else if (isInFlight) {
        renderTypingDots(row.body);
      }
      return;
    }

    for (const block of msg.content) {
      await renderBlock(row.body, block, blockCtx);
    }

    // First-token delay: assistant streamed turn that hasn't emitted
    // any rendered content yet. Show three pulsing dots so the user
    // knows something is happening (the row's streaming border-pulse
    // is subtle on mobile).
    if (isInFlight && msg.role === 'assistant' && !hasRenderedContent(msg)) {
      renderTypingDots(row.body);
    }

    // Per-message action row at the bottom of every finalized Claude
    // turn. Hover-based actions don't work on mobile, so always visible.
    if (msg.role === 'assistant' && !isInFlight) {
      renderMessageActions(row.el, msg, {
        app: this.ctx.app,
        savedNotesFolder: this.ctx.savedNotesFolder,
      });
    }
  }
}

/** Render three pulsing dots into a row body. Pure CSS animation —
 * see styles.css `.scribian-typing-dot`. */
function renderTypingDots(parent: HTMLElement): void {
  const wrap = parent.createDiv({ cls: 'scribian-typing' });
  wrap.createSpan({ cls: 'scribian-typing-dot' });
  wrap.createSpan({ cls: 'scribian-typing-dot' });
  wrap.createSpan({ cls: 'scribian-typing-dot' });
}

/**
 * True when an in-flight assistant message has at least one block
 * that produces visible content (text/thinking with non-empty text,
 * tool_use, image, etc.). Used to decide whether to show typing
 * dots while waiting for the first token.
 */
function hasRenderedContent(msg: Message): boolean {
  if (typeof msg.content === 'string') {
    return msg.content.trim().length > 0;
  }
  for (const block of msg.content) {
    const b = block as { type: string; text?: string; thinking?: string };
    if (b.type === 'text' && (b.text ?? '').trim()) return true;
    if (b.type === 'thinking' && (b.thinking ?? '').trim()) return true;
    if (b.type !== 'text' && b.type !== 'thinking') return true;
  }
  return false;
}

// CSS.escape isn't always available; fall back to a regex strip for
// safety. Inlined here so message-list stays self-contained.
function escapeCss(s: string): string {
  if (typeof (window as any).CSS?.escape === 'function') {
    return (window as any).CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
