import { App, normalizePath } from 'obsidian';
import type { Provider } from '@skald/protocol';

export interface ToolExecutionResult {
  content: string;
  is_error?: boolean;
  /** True when this result was already compacted in-runner (e.g. the three
   * large-output tools that compact before their internal byte cap).  The
   * dispatch-point compaction in connect-session.ts MUST skip results with
   * this flag set to prevent double-compaction. */
  compacted?: boolean;
}

export type WriteKind = 'create' | 'overwrite' | 'edit' | 'append';

export interface WriteProposal {
  toolUseId: string;
  kind: WriteKind;
  path: string;
  before: string | null;
  after: string;
  /** Vault paths (and search queries) the assistant consulted on
   * this turn before proposing the write. Surfaced in the diff card
   * so the user can audit where the proposal's reasoning came from
   * — and reject confidently when it pulled from somewhere they
   * didn't expect. */
  informedBy?: string[];
}

export type ApproveFn = (proposal: WriteProposal) => Promise<boolean>;

/**
 * Context every tool executor receives. Required fields are the
 * foundation (Vault API + approval flow); optional fields gate
 * specific tools. This keeps the executor a single dispatch point
 * with no special-cases at the call site.
 */
export interface ToolContext {
  app: App;
  approve: ApproveFn;
  /** Vault-relative path to the memory note (e.g. `Skald/Memory.md`).
   * Used by the explicit memory tools (remember_fact / update_memory /
   * forget_fact) so the model doesn't have to know the path. Absent →
   * those tools return a "not configured" error. */
  memoryPath?: string;
  /**
   * Anthropic API key for ancillary in-plugin calls (e.g. rerank).
   * Absent → ancillary features that require it soft-fail gracefully.
   */
  anthropicApiKey?: string;
  /**
   * The active chat provider. The Haiku reranker calls Anthropic
   * directly, so it must only fire when the user's active provider IS
   * Anthropic — an OpenRouter user shouldn't silently hit a second
   * provider (one-trust-boundary principle). Absent → treated as
   * 'anthropic' for backward compatibility.
   */
  provider?: Provider;
  /**
   * Whether to compact tool results before the byte cap.  When true the
   * three large-output tools (read_note / list_notes / search_vault) run
   * compaction inside their runner, before `capResult`, so densified
   * content survives the budget.  Absent → treated as true (on by default).
   */
  compactToolResults?: boolean;
}

/**
 * Vault-relative path validator shared by read + write tools. Rejects
 * absolute paths and paths containing `..` segments that could escape
 * the vault root. normalizePath also folds `/./` and trailing
 * separators.
 */
export function safePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const normalized = normalizePath(raw);
  if (normalized.includes('..')) return null;
  if (normalized.startsWith('/')) return null;
  return normalized;
}
