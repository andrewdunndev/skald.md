/**
 * Resume a saved Scribian conversation in the chat pane.
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
  session: ChatSession | null;
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
  if (ctx.session) {
    const chatCost = estimateTurnCost(
      ctx.session.getTotalUsage(),
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

  const session = ctx.session;
  if (!session) return;

  session.hydrate({
    conversationId: parsed.meta.id!,
    model: parsed.meta.model,
    messages: parsed.messages,
    usage: parsed.meta.usage,
  });

  await ctx.messageList.flushRender(session.getMessages(), null);

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
