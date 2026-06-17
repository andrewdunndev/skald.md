/**
 * Conversation search (phase 10b).
 *
 * Fuzzy-searches saved conversation files in the configured Chats
 * folder and opens the matched conversation as a markdown note when
 * picked. Triggered from the command palette ("Scribian: Search
 * conversations") or via the workspace search hotkey if a chat pane
 * is focused (wired in main.ts).
 *
 * Ranking: prepareFuzzySearch score on title + body, with a recency
 * multiplier that biases toward conversations modified in the last
 * few days — usually you're looking for the recent thing, not the
 * thing you forgot you ever talked about.
 *
 * Implementation: lazy index built on modal open. For ~1000
 * conversation files this loads ~5MB of markdown into memory for
 * the duration the modal is open; closed → garbage collected.
 * A persistent inverted index could land later if real users hit
 * latency, but a 1000-file scan on a modern machine is sub-second.
 */

import {
  App,
  Notice,
  SuggestModal,
  TFile,
  prepareFuzzySearch,
  normalizePath,
} from 'obsidian';

export interface ConversationHit {
  file: TFile;
  title: string;
  excerpt: string;
  mtime: number;
  score: number;
}

interface IndexedConversation {
  file: TFile;
  title: string;
  body: string;
}

export interface ConversationSearchOptions {
  /** When provided, selecting a conversation resumes it in the chat
   * pane instead of opening it as a read-only note. */
  onResume?: (file: TFile) => void;
}

export class ConversationSearchModal extends SuggestModal<ConversationHit> {
  private cache: IndexedConversation[] | null = null;
  private readonly folder: string;
  private readonly onResume: ((file: TFile) => void) | undefined;

  constructor(app: App, folder: string, opts: ConversationSearchOptions = {}) {
    super(app);
    this.folder = folder;
    this.onResume = opts.onResume;
    const action = opts.onResume ? 'resume conversation' : 'open conversation';
    this.setPlaceholder('Search saved conversations…');
    this.setInstructions([
      { command: 'Enter', purpose: action },
      { command: 'Esc', purpose: 'close' },
    ]);
  }

  override async getSuggestions(query: string): Promise<ConversationHit[]> {
    const index = await this.ensureIndex();
    if (index.length === 0) return [];

    const q = query.trim();
    if (!q) {
      // No query → show most recent N as a "Recent" view.
      return index
        .map((c) => ({
          file: c.file,
          title: c.title,
          excerpt: firstNonEmptyLine(c.body, 140),
          mtime: c.file.stat.mtime,
          score: 0,
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20);
    }

    const fuzzy = prepareFuzzySearch(q);
    const now = Date.now();
    const matched: ConversationHit[] = [];
    for (const c of index) {
      const titleMatch = fuzzy(c.title);
      const bodyMatch = fuzzy(c.body);
      const rawScore =
        (titleMatch?.score ?? 0) * 1.5 + (bodyMatch?.score ?? 0);
      if (rawScore === 0) continue;
      // Recency multiplier: 1.0 today, ~0.7 a week ago,
      // ~0.5 a month, ~0.3 a quarter. Boosts recent matches without
      // overwhelming a strong textual match on an older conversation.
      const ageDays = Math.max(
        0,
        (now - c.file.stat.mtime) / (1000 * 60 * 60 * 24),
      );
      const recencyMul = 0.3 + 0.7 / (1 + ageDays / 14);
      matched.push({
        file: c.file,
        title: c.title,
        excerpt: excerptAroundMatch(c.body, q, 140),
        mtime: c.file.stat.mtime,
        score: rawScore * recencyMul,
      });
    }
    matched.sort((a, b) => b.score - a.score);
    return matched.slice(0, 20);
  }

  override renderSuggestion(hit: ConversationHit, el: HTMLElement): void {
    el.empty();
    el.addClass('scribian-conv-suggest');
    const head = el.createDiv({ cls: 'scribian-conv-suggest-head' });
    head.createSpan({ cls: 'scribian-conv-suggest-title', text: hit.title });
    head.createSpan({
      cls: 'scribian-conv-suggest-date',
      text: relativeTime(hit.mtime),
    });
    el.createDiv({
      cls: 'scribian-conv-suggest-excerpt',
      text: hit.excerpt,
    });
  }

  override onChooseSuggestion(hit: ConversationHit): void {
    if (this.onResume) {
      this.onResume(hit.file);
    } else {
      void this.app.workspace.openLinkText(hit.file.path, '', false);
    }
  }

  private async ensureIndex(): Promise<IndexedConversation[]> {
    if (this.cache) return this.cache;
    const folder = this.folder.trim();
    if (!folder) {
      new Notice('No chats folder configured.');
      this.cache = [];
      return this.cache;
    }
    const folderPath = normalizePath(folder).replace(/\/$/, '');
    const out: IndexedConversation[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folderPath + '/')) continue;
      try {
        const body = await this.app.vault.cachedRead(file);
        out.push({ file, title: titleFor(file, body), body });
      } catch {
        // skip unreadable file
      }
    }
    this.cache = out;
    return out;
  }
}

/** Pull a human title from frontmatter / first user line / basename. */
function titleFor(file: TFile, body: string): string {
  // Frontmatter title if present.
  const fmTitle = body.match(/^---\n[\s\S]*?title:\s*"?([^"\n]+)"?[\s\S]*?\n---/);
  if (fmTitle?.[1]) return fmTitle[1].trim();
  // First "## You" body line — typically the question that started
  // the conversation.
  const m = body.match(/##\s*You\s*\n\s*([^\n]+)/);
  if (m?.[1]) return m[1].slice(0, 80).trim();
  // Fallback: basename without the date prefix + slug.
  return file.basename;
}

function firstNonEmptyLine(body: string, max: number): string {
  // Skip frontmatter.
  const stripped = body.startsWith('---\n')
    ? body.replace(/^---\n[\s\S]*?\n---\n?/, '')
    : body;
  for (const line of stripped.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
  return '';
}

function excerptAroundMatch(body: string, query: string, max: number): string {
  const lower = body.toLowerCase();
  const q = query.toLowerCase().trim();
  const hit = q ? lower.indexOf(q) : -1;
  if (hit < 0) return firstNonEmptyLine(body, max);
  const halfWindow = Math.max(0, Math.floor((max - q.length) / 2));
  const start = Math.max(0, hit - halfWindow);
  const end = Math.min(body.length, hit + q.length + halfWindow);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60 * 1000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hr)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 60 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
