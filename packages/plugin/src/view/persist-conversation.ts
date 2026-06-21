/**
 * Persist the active chat session to the vault's chats folder.
 *
 * Extracted from view.ts (LOC-cap refactor): the save is a
 * self-contained side effect — given an app, session, folder, and
 * model id, it writes the conversation note. The view calls it after
 * each finalized turn. No-ops when there's no session or no
 * configured chats folder.
 */
import type { App } from 'obsidian';
import type { ChatSession } from '../chat-session';
import { saveConversation } from '../conversation-store';
import { estimateTurnCost } from '../pricing';

export async function persistConversation(
  app: App,
  session: ChatSession | null,
  folderRaw: string,
  model: string,
): Promise<void> {
  if (!session) return;
  const folder = folderRaw.trim();
  if (!folder) return;
  const totalUsage = session.getTotalUsage();
  const costUSD = estimateTurnCost(totalUsage, model);
  await saveConversation(
    app,
    folder,
    {
      id: session.conversationId,
      model,
      created: session.conversationCreated,
      updated: new Date().toISOString(),
      usage: totalUsage,
      costUSD,
    },
    session.getMessages(),
  );
}
