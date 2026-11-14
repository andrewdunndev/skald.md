/**
 * Persist a conversation to the vault as a markdown note.
 *
 * Split out from conversation-store.ts (which stays pure render/parse) so
 * the vault-I/O surface — and the manual-edit guard below — lives in one
 * place. The note is re-rendered and re-saved every turn; the guard keeps
 * those machine re-saves from clobbering a note the user hand-edited.
 */
import { App, normalizePath, TFile } from 'obsidian';
import type { Message } from './protocol';
import type { Logger } from './logger';
import {
  renderConversationMarkdown,
  slugify,
  stripContext,
  type ConversationMeta,
} from './conversation-store';

/**
 * Per-conversation-id snapshot of the content hash skald last wrote. Lets
 * saveConversation tell "this is the file we own, unchanged" apart from
 * "the user hand-edited it" so machine re-saves never clobber human edits.
 * Bounded by the number of distinct conversation ids touched this session.
 */
const lastWritten = new Map<string, number>();

/** Cheap, stable 32-bit content hash (FNV-1a). Used only for divergence
 * detection between the last machine write and the current on-disk body. */
function hashBody(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Test-only: clear the per-conversation last-written snapshots so each
 * test starts from a clean "no prior write" state. */
export function __resetConversationWriteCache(): void {
  lastWritten.clear();
}

/**
 * Save (or update) the conversation file in the configured chats folder.
 * Filename uses the conversation id so subsequent updates rewrite the
 * same file. Folder is auto-created.
 *
 * Manual-edit guard: the note is re-saved every turn, but skald only owns
 * the content it last wrote. Before overwriting an existing note we re-read
 * the live on-disk content inside vault.process and, if it diverges from our
 * last-written snapshot, the user (or sync) edited it — we skip the machine
 * overwrite rather than discarding the edit. The first save for an id has no
 * snapshot yet, so it commits.
 */
export async function saveConversation(
  app: App,
  folder: string,
  meta: ConversationMeta,
  messages: Message[],
  logger?: Logger,
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
      `skald: refusing to save outside folder (resolved="${path}" folder="${normalizedFolder}")`,
    );
    return null;
  }

  const body = renderConversationMarkdown(meta, messages);
  const existing = app.vault.getAbstractFileByPath(path);
  try {
    if (existing instanceof TFile) {
      const last = lastWritten.get(meta.id);
      let diverged = false;
      await app.vault.process(existing, (current) => {
        if (last !== undefined && hashBody(current) !== last) {
          diverged = true;
          return current; // leave the user's edit untouched
        }
        return body;
      });
      if (diverged) {
        logger?.warn(`skipped saving ${path}: the note changed since the last save`);
        return existing;
      }
      lastWritten.set(meta.id, hashBody(body));
      return existing;
    }
    const created = await app.vault.create(path, body);
    lastWritten.set(meta.id, hashBody(body));
    return created;
  } catch (err) {
    console.error('skald: saveConversation failed', err);
    return null;
  }
}
