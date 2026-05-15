import { App, normalizePath } from 'obsidian';
import type { MemoryClientConfig } from '../memory-client';

export interface ToolExecutionResult {
  content: string;
  is_error?: boolean;
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
 * specific tools (memoryClient for find_related). This keeps the
 * executor a single dispatch point with no special-cases at the
 * call site.
 */
export interface ToolContext {
  app: App;
  approve: ApproveFn;
  /** Phase 6: enables find_related. Absent → tool returns a clear
   * "not configured" error. */
  memoryClient?: MemoryClientConfig;
  /** Vault-relative path to the memory note (e.g. `Scribian/Memory.md`).
   * Used by the explicit memory tools (remember_fact / update_memory /
   * forget_fact) so the model doesn't have to know the path. Absent →
   * those tools return a "not configured" error. */
  memoryPath?: string;
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
