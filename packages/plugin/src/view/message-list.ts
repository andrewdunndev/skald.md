import {
  App,
  Component,
  setIcon,
  type ItemView,
} from 'obsidian';
import type { Message } from '../protocol';
import {
  renderBlock,
  renderMarkdownInto,
  type BlockContext,
} from './block-renderer';
import { renderMessageActions } from './message-actions';
import { announceableText } from './live-region';
import {
  renderChipsInto,
  renderEmptyState,
  type StarterChip,
} from './empty-state';
import type { WriteProposal } from '../tools';

const RENDER_THROTTLE_MS = 150;

/**
 * Distance from the scroll bottom (in px) within which the list is
 * considered "at the bottom" for auto-scroll purposes. Anything
 * beyond this means the user has deliberately scrolled up to read
 * history — we leave the viewport alone in that case.
 */
const NEAR_BOTTOM_THRESHOLD_PX = 50;

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
   * reviews + sends in the normal flow. The full chip is passed
   * so the host can react to flags like attachImage. */
  onStarterPick: (chip: StarterChip) => void;
  /** Optional async loader for the empty-state starter chips. Called
   * each time the empty state is rendered (open + new chat), so
   * edits to a vault-side Starters.md show up on the next clean
   * pane. Returns DEFAULT_STARTER_CHIPS when not provided. */
  loadStarterChips?: () => Promise<StarterChip[]>;
  /** Called when the user taps a "Propose write to X.md" nudge on a
   * finalized assistant turn. Host fills the composer with a
   * follow-up prompt asking Claude to actually emit the write. */
  onSuggestWrite?: (path: string) => void;
  /** Called when the user taps Resend on a retryable inline error block.
   * Host re-dispatches the last user turn via the chat session. */
  onResend?: () => void;
  /**
   * Optional: supplier for the live document registry (document_index
   * → vault path) from the active ChatSession. When provided, assistant
   * text blocks carrying Anthropic Citations API citation objects will
   * render inline superscript markers linking to the source note.
   * Absent → citation rendering is skipped (non-Anthropic path).
   */
  getDocumentRegistry?: () => ReadonlyMap<number, string>;
  /**
   * Optional: push finalized assistant text into a polite ARIA live
   * region so screen-reader users hear the reply. Called once per
   * turn at the moment the in-flight row finalizes — never per
   * streaming delta — to avoid flooding the assistive-tech queue.
   * See live-region.ts for the rationale behind the dedicated region.
   */
  announce?: (text: string) => void;
}

/**
 * Streaming chat message list. Owns the scrollable messages
 * container; rebuilds rows incrementally as the chat session emits
 * updates. SkaldView calls requestRender() on every update; the
 * list batches with a 150ms throttle before walking the diff between
 * its current row count + the session's history.
 */
export class MessageList {
  private readonly messagesEl: HTMLDivElement;
  private readonly ctx: MessageListContext;
  private rows: MessageRow[] = [];
  private renderTimer: number | null = null;
  private emptyStateEl: HTMLDivElement | null = null;
  /**
   * Set to true by requestRender() when a forceScroll intent arrives
   * mid-coalesce window, so the pending timer fires with the flag even
   * if subsequent coalesced calls omit it.
   */
  private pendingForceScroll = false;

  constructor(parent: HTMLElement, ctx: MessageListContext) {
    this.ctx = ctx;
    this.messagesEl = parent.createDiv({ cls: 'skald-messages' });
    // role="log" marks this as an append-only message stream so screen
    // readers apply correct semantics (WCAG 1.3.1, fix E). The dedicated
    // LiveRegion handles polite turn announcements; this role gives
    // the structural context for AT navigation.
    this.messagesEl.setAttrs({ role: 'log', 'aria-label': 'Chat messages' });
    this.renderEmptyState();
  }

  private renderEmptyState(): void {
    this.emptyStateEl?.remove();
    this.emptyStateEl = renderEmptyState(this.messagesEl, {
      onChipPick: (chip) => this.ctx.onStarterPick(chip),
    });
    // Async refresh of starter chips from the vault — replaces the
    // default set the renderEmptyState call mounted synchronously.
    // Guards against TOCTOU: only patch if the empty state is still
    // the one we just rendered (user may have started a turn).
    const target = this.emptyStateEl;
    if (this.ctx.loadStarterChips) {
      void this.ctx.loadStarterChips().then((chips) => {
        if (this.emptyStateEl !== target) return;
        const chipRow = target.querySelector(
          '.skald-empty-chips',
        ) as HTMLDivElement | null;
        if (!chipRow) return;
        renderChipsInto(chipRow, chips, (chip) =>
          this.ctx.onStarterPick(chip),
        );
      });
    }
  }

  private clearEmptyState(): void {
    this.emptyStateEl?.remove();
    this.emptyStateEl = null;
  }

  el(): HTMLDivElement {
    return this.messagesEl;
  }

  /**
   * True when the scroll container is at or near the bottom, meaning
   * the user has not scrolled up into history. Used by flushRender to
   * decide whether streaming updates should track the new content.
   *
   * Must be called BEFORE the DOM update so the measurement reflects
   * the pre-render scroll position.
   */
  private isNearBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX;
  }

  /**
   * Scroll to the very bottom of the message list immediately.
   * Exposed so the view layer can force a jump after the user's own
   * send, regardless of where the viewport currently sits.
   */
  scrollToBottom(): void {
    if (typeof this.messagesEl.scrollTo === 'function') {
      this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
    } else {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  /** Schedule a render. Coalesces multiple updates within the throttle
   * window so streaming SSE chunks don't trigger a render per delta.
   *
   * Takes GETTERS (not values) so the throttled tick reads live
   * state at fire time. Capturing the values at schedule time was a
   * real bug: a getInFlight() returning a non-null reference at
   * schedule time would be re-evaluated as still-truthy at fire
   * time EVEN IF the session had nulled its inFlight between
   * schedule and fire. Result: an extra DOM row for an inFlight
   * that had already been finalized + appended to the history.
   * Manifested as duplicate assistant rows after every chat turn.
   *
   * @param forceScroll - When true, scroll to bottom unconditionally
   *   regardless of current scroll position. Use for the user's own
   *   sends so the view jumps to their new message immediately. For
   *   mid-stream assistant updates, omit (or pass false): the list
   *   only auto-scrolls when the user is already near the bottom,
   *   preserving their position if they scrolled up to read history. */
  requestRender(
    getHistory: () => Message[],
    getInFlight: () => { blocks: Message['content'] } | null,
    forceScroll = false,
  ): void {
    if (forceScroll) {
      // Latch the force-scroll intent so it survives across coalesced
      // render requests that arrive while the timer is already pending.
      this.pendingForceScroll = true;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      const force = this.pendingForceScroll;
      this.pendingForceScroll = false;
      void this.flushRender(getHistory(), getInFlight(), force);
    }, RENDER_THROTTLE_MS);
  }

  /** Immediate render — used for finalizing a turn (after onDone) so
   * the assistant message stops streaming and locks its rendered DOM.
   *
   * @param forceScroll - When true, scroll to bottom unconditionally.
   *   Defaults to false; the render checks the pre-update scroll
   *   position and only scrolls when the user is already near the
   *   bottom. Pass true for resume-conversation loads so the view
   *   opens at the tail of the loaded history. */
  async flushRender(
    history: Message[],
    inFlight: { blocks: Message['content'] } | null,
    forceScroll = false,
  ): Promise<void> {
    // Capture scroll position BEFORE mutating the DOM so the measurement
    // reflects the user's intent, not the post-render layout.
    const shouldScroll = forceScroll || this.isNearBottom();

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
      row.el.toggleClass('skald-msg-streaming', isInFlight);
      if (row.finalized && !isInFlight) continue;
      await this.renderRow(row, msg, isInFlight);
      if (!isInFlight) {
        row.finalized = true;
        // Announce the finalized assistant turn to the polite live
        // region — once, on the transition to finalized, so the
        // screen reader gets the whole reply and never the partials.
        if (msg.role === 'assistant') {
          this.ctx.announce?.(announceableText(msg));
        }
      }
    }

    // Only auto-scroll when the user was already at/near the bottom
    // before this render, or when the caller explicitly forced it
    // (e.g. the user's own send, or a resume-conversation load).
    // This prevents yanking the viewport when the user has scrolled
    // up to read history while a long response is still streaming in.
    if (shouldScroll) {
      if (typeof this.messagesEl.scrollTo === 'function') {
        this.messagesEl.scrollTo({
          top: this.messagesEl.scrollHeight,
          behavior: 'smooth',
        });
      } else {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
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
      `.skald-diff[data-tool-use-id="${escapeCss(toolUseId)}"]`,
    );
  }

  private appendRow(): void {
    const el = this.messagesEl.createDiv({ cls: 'skald-msg' });
    // role="listitem" pairs with the parent role="log" container so
    // AT can navigate message turns individually (fix E).
    el.setAttr('role', 'listitem');
    el.createSpan({ cls: 'skald-msg-who' });
    const body = el.createDiv({ cls: 'skald-msg-body' });
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
    row.el.removeClass('skald-msg-user', 'skald-msg-assistant');
    row.el.addClass(`skald-msg-${msg.role}`);

    const whoEl = row.el.querySelector(
      '.skald-msg-who',
    ) as HTMLElement | null;
    if (whoEl) {
      whoEl.empty();
      const avatar = whoEl.createSpan({ cls: 'skald-msg-avatar' });
      // Icon is purely decorative — the text label carries the name (D).
      avatar.setAttr('aria-hidden', 'true');
      setIcon(avatar, msg.role === 'user' ? 'user' : 'sparkles');
      whoEl.createSpan({
        cls: 'skald-msg-label',
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
      documentRegistry: this.ctx.getDocumentRegistry?.(),
      onResend: this.ctx.onResend,
    };

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        const wrap = row.body.createDiv({ cls: 'skald-text' });
        await renderMarkdownInto(wrap, msg.content, blockCtx);
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
        onSuggestWrite: this.ctx.onSuggestWrite,
      });
    }
  }
}

/** Render three pulsing dots into a row body. Pure CSS animation —
 * see styles.css `.skald-typing-dot`. */
function renderTypingDots(parent: HTMLElement): void {
  const wrap = parent.createDiv({ cls: 'skald-typing' });
  wrap.createSpan({ cls: 'skald-typing-dot' });
  wrap.createSpan({ cls: 'skald-typing-dot' });
  wrap.createSpan({ cls: 'skald-typing-dot' });
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
  const css = (window as unknown as { CSS?: { escape?: (s: string) => string } })
    .CSS;
  if (typeof css?.escape === 'function') {
    return css.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
