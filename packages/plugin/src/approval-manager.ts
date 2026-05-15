/**
 * Pending-approval lifecycle for vault-write tools.
 *
 * Every write tool (write_note / edit_note / append_to_note) requires
 * explicit user approval via a diff card. The manager owns the state
 * (which proposals are pending) + the resolution lifecycle (which
 * Promise resolves to true/false when the user clicks approve/reject).
 *
 * Pure TypeScript — no Obsidian dependencies. The view layer renders
 * the diff card and wires the click handlers to `resolve(id, true|false)`;
 * the tool executor awaits the Promise returned from `request()`. The
 * manager doesn't know about DOM or vault paths beyond what's already
 * in `WriteProposal`.
 *
 * Architectural rationale (per dunn.dev/reference principles —
 * derived obligations): keeping the manager pure means a test can
 * assert "request + resolve produces approved=true" with no Obsidian
 * runtime mock. Vacuity-detection: the test asserts the resolved
 * value of the Promise + the hook callbacks fired with the right
 * args, not just "doesn't throw."
 */

import type { WriteProposal } from './tools';

export interface ApprovalEntry {
  proposal: WriteProposal;
  resolve: (approved: boolean) => void;
}

export interface ApprovalHooks {
  /** Fired after the pending map changes (add / remove). Lets the
   * view trigger a re-render to show the diff card. */
  onPendingChange?: () => void;
  /** Fired when an entry is resolved with the user's decision.
   * Lets the view audit-log the outcome. */
  onResolve?: (proposal: WriteProposal, approved: boolean) => void;
}

export class ApprovalManager {
  private readonly pending = new Map<string, ApprovalEntry>();

  constructor(private readonly hooks: ApprovalHooks = {}) {}

  /**
   * Register a pending approval. Returns a Promise that resolves to
   * `true` when the user approves, `false` when rejected. The Promise
   * never rejects — a stuck approval just stays pending forever until
   * the user clicks one of the buttons (or the conversation is
   * reset, in which case the renderer cleans up its DOM and the
   * Promise is abandoned).
   */
  request(proposal: WriteProposal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.set(proposal.toolUseId, { proposal, resolve });
      this.hooks.onPendingChange?.();
    });
  }

  /**
   * Resolve a pending approval with the user's decision. Returns
   * `true` if a pending entry existed (and was therefore resolved);
   * `false` if the toolUseId didn't match anything (idempotent — a
   * double-click on the diff card's approve button after the first
   * click already cleared the entry won't break anything).
   */
  resolve(toolUseId: string, approved: boolean): boolean {
    const entry = this.pending.get(toolUseId);
    if (!entry) return false;
    this.pending.delete(toolUseId);
    this.hooks.onResolve?.(entry.proposal, approved);
    entry.resolve(approved);
    return true;
  }

  /** Lookup for the renderer: "is this tool_use awaiting approval?" */
  get(toolUseId: string): ApprovalEntry | undefined {
    return this.pending.get(toolUseId);
  }

  /** Same lookup, boolean variant for use in conditionals. */
  has(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  /** Number of pending approvals (mostly for tests + diagnostics). */
  size(): number {
    return this.pending.size;
  }

  /**
   * Auto-reject every pending approval. Called when the chat session
   * is reset or the view is closed — leaving a Promise stranded in
   * memory is a leak. Each abandoned approval resolves to `false`
   * so the awaiting tool executor unblocks gracefully.
   */
  abandonAll(): void {
    for (const entry of this.pending.values()) {
      entry.resolve(false);
    }
    this.pending.clear();
    this.hooks.onPendingChange?.();
  }
}
