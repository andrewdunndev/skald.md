/**
 * Resume a saved Skald conversation in the chat pane.
 *
 * Reads the conversation file, parses it back into Message[], hydrates a
 * fresh ChatSession, and re-paints the message list so the user can
 * continue typing where they left off.
 */
import { Notice, type App, type TFile } from 'obsidian';
import type { ChatSession } from '../chat-session';
import type { MessageList } from './message-list';
import { parseConversationMarkdown } from '../conversation-store';
import { estimateTurnCost, formatSessionFooter } from '../pricing';

export interface ResumeContext {
  app: App;
  /**
   * Live read of the view's current session. MUST be a getter, not a
   * snapshot: connect() swaps the view's session reference, so the
   * hydrate target is only correct when read AFTER connect() runs.
   * A captured value would point at the pre-connect (now-detached)
   * session, leaving the live view bound to a fresh empty one.
   */
  getSession: () => ChatSession | null;
  connect: () => void;
  messageList: MessageList;
  dropSessionState: () => void;
  getModelValue: () => string;
  getTransport: () => { close(): void } | null;
  setTransport: (t: null) => void;
  setSession: (s: null) => void;
  usageFooterEl: HTMLDivElement;
  onPreClear: (chatCostUSD: number) => void;
}

/**
 * Full resume flow: tear down current state, re-connect, hydrate the
 * parsed messages, and repaint the history. Falls back to opening the
 * note when the file can't be parsed.
 */
export async function resumeConversation(
  file: TFile,
  ctx: ResumeContext,
): Promise<void> {
  let content: string;
  try {
    content = await ctx.app.vault.read(file);
  } catch {
    new Notice('Could not read conversation file.');
    return;
  }

  const parsed = parseConversationMarkdown(content);
  if (!parsed) {
    new Notice("Couldn't resume this chat — opened it for reading.");
    void ctx.app.workspace.openLinkText(file.path, '', false);
    return;
  }

  // Roll current chat cost into session cumulative before clearing.
  // Read the session here (pre-teardown) so the outgoing chat's spend
  // is captured before connect() swaps in a fresh session.
  const outgoing = ctx.getSession();
  if (outgoing) {
    const chatCost = estimateTurnCost(
      outgoing.getTotalUsage(),
      ctx.getModelValue(),
    );
    ctx.onPreClear(chatCost);
  }

  ctx.messageList.tearDown();
  ctx.dropSessionState();
  ctx.usageFooterEl.style.display = 'none';

  ctx.getTransport()?.close();
  ctx.setTransport(null);
  ctx.setSession(null);
  ctx.connect();

  // Read the session AFTER connect(): connect() installs a brand-new
  // session on the view, so this is the reference the live view will
  // send through. Hydrating any earlier-captured reference would
  // hydrate a detached session and leave the view empty.
  const session = ctx.getSession();
  if (!session) return;

  session.hydrate({
    conversationId: parsed.meta.id!,
    model: parsed.meta.model,
    messages: parsed.messages,
    usage: parsed.meta.usage,
  });

  // Pass forceScroll=true so the view opens at the tail of the loaded
  // history, regardless of where the container scroll currently sits.
  await ctx.messageList.flushRender(session.getMessages(), null, true);

  if (parsed.meta.usage) {
    const total = session.getTotalUsage();
    // sessionPriorUSD comes from onPreClear accumulation; view reads it
    // via the footer call with live value (passed through formatSessionFooter).
    const footerText = formatSessionFooter(
      total,
      ctx.getModelValue(),
      0, // session prior cost managed by view; footer shows chat cost here
    );
    ctx.usageFooterEl.setText(footerText);
    ctx.usageFooterEl.style.display = '';
  }
}
