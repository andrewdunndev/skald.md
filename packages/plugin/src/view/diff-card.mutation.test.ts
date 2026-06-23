/**
 * Tests for diff-card.ts — renderDiffCard ARIA + structural contract.
 *
 * Finding: diff-card.ts has ZERO dedicated test coverage. renderDiffCard
 * is the only write-approval UI entry point; its ARIA attributes and
 * button structure are load-bearing for a11y and keyboard navigation.
 *
 * Coverage scope:
 *   - card has role="group" + aria-label naming the operation
 *   - Approve button has aria-label="Approve write"
 *   - Reject button has aria-label="Reject write"
 *   - Clicking Approve calls onApprove with the correct toolUseId
 *   - Clicking Reject calls onReject with the correct toolUseId
 *   - Card does NOT steal focus on mount (regression guard for the
 *     fix that moved focus-restore to resolveApprovalUi in view.ts)
 *
 * Implementation: minimal Obsidian element stubs in-file. The test
 * harness runs in node (no jsdom); Obsidian's HTMLElement extensions
 * (createDiv, createEl, setAttr, setAttrs) are shimmed here as
 * simple recording objects.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderDiffCard } from './diff-card';
import type { WriteProposal } from '../tools';

// ---------------------------------------------------------------------------
// Minimal Obsidian HTMLElement stub
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>;

interface StubEl {
  tag: string;
  cls: string;
  attrs: Attrs;
  children: StubEl[];
  text: string;
  listeners: Record<string, Array<(e: unknown) => void>>;
  // Mirrors HTMLElement shape expected by renderDiffCard.
  style: Record<string, string>;
  isConnected: boolean;
  focus(): void;
  setAttr(k: string, v: string): void;
  setAttrs(a: Attrs): void;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  setText(t: string): void;
  createDiv(opts?: { cls?: string; text?: string }): StubEl;
  createSpan(opts?: { cls?: string; text?: string }): StubEl;
  createEl(tag: string, opts?: { cls?: string; attr?: Attrs }): StubEl;
  addEventListener(ev: string, fn: (e: unknown) => void): void;
  empty(): void;
}

function makeEl(tag = 'div'): StubEl {
  const el: StubEl = {
    tag,
    cls: '',
    attrs: {},
    children: [],
    text: '',
    listeners: {},
    style: {},
    isConnected: true,
    focus() { /* no-op in node */ },
    setText(t) { el.text = t; },
    setAttr(k, v) { el.attrs[k] = v; },
    setAttrs(a) { Object.assign(el.attrs, a); },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k] ?? null; },
    createDiv(opts?) {
      const child = makeEl('div');
      child.cls = opts?.cls ?? '';
      child.text = opts?.text ?? '';
      el.children.push(child);
      return child;
    },
    createSpan(opts?) {
      const child = makeEl('span');
      child.cls = opts?.cls ?? '';
      child.text = opts?.text ?? '';
      el.children.push(child);
      return child;
    },
    createEl(tag2, opts?) {
      const child = makeEl(tag2);
      child.cls = opts?.cls ?? '';
      if (opts?.attr) Object.assign(child.attrs, opts.attr);
      el.children.push(child);
      return child;
    },
    addEventListener(ev, fn) {
      (el.listeners[ev] ??= []).push(fn);
    },
    empty() { el.children.length = 0; },
  };
  return el;
}

function dispatch(el: StubEl, ev: string): void {
  for (const fn of el.listeners[ev] ?? []) fn({});
}

/** Walk the stub tree and return the first el matching a predicate. */
function find(root: StubEl, pred: (e: StubEl) => boolean): StubEl | undefined {
  if (pred(root)) return root;
  for (const c of root.children) {
    const found = find(c, pred);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROPOSAL: WriteProposal = {
  toolUseId: 'tool-abc-123',
  kind: 'edit',
  path: 'notes/foo.md',
  before: 'old content',
  after: 'new content',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderDiffCard: ARIA + landmark', () => {
  it('wraps the card in role="group"', () => {
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    // The card div is the first child of parent.
    const card = parent.children[0];
    expect(card).toBeDefined();
    expect(card.attrs['role']).toBe('group');
  });

  it('aria-label names the kind and path so screen readers announce context', () => {
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const card = parent.children[0];
    expect(card.attrs['aria-label']).toContain('edit');
    expect(card.attrs['aria-label']).toContain('notes/foo.md');
  });

  it('aria-label changes with proposal kind (create vs edit)', () => {
    const p2: WriteProposal = { ...PROPOSAL, kind: 'create', path: 'new.md' };
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, p2, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const label = parent.children[0].attrs['aria-label'] ?? '';
    expect(label).toContain('create');
    expect(label).toContain('new.md');
  });
});

describe('renderDiffCard: Approve + Reject buttons', () => {
  it('Approve button has aria-label="Approve write"', () => {
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const approve = find(parent, (e) => e.attrs['aria-label'] === 'Approve write');
    expect(approve).toBeDefined();
    expect(approve?.tag).toBe('button');
  });

  it('Reject button has aria-label="Reject write"', () => {
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const reject = find(parent, (e) => e.attrs['aria-label'] === 'Reject write');
    expect(reject).toBeDefined();
    expect(reject?.tag).toBe('button');
  });

  it('clicking Approve calls onApprove with the correct toolUseId', () => {
    const parent = makeEl();
    const onApprove = vi.fn();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove,
      onReject: vi.fn(),
    });
    const approve = find(parent, (e) => e.attrs['aria-label'] === 'Approve write');
    expect(approve).toBeDefined();
    dispatch(approve!, 'click');
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledWith(PROPOSAL.toolUseId);
  });

  it('clicking Reject calls onReject with the correct toolUseId', () => {
    const parent = makeEl();
    const onReject = vi.fn();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject,
    });
    const reject = find(parent, (e) => e.attrs['aria-label'] === 'Reject write');
    expect(reject).toBeDefined();
    dispatch(reject!, 'click');
    expect(onReject).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledWith(PROPOSAL.toolUseId);
  });

  it('clicking Approve does NOT call onReject', () => {
    const parent = makeEl();
    const onReject = vi.fn();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject,
    });
    const approve = find(parent, (e) => e.attrs['aria-label'] === 'Approve write');
    dispatch(approve!, 'click');
    expect(onReject).not.toHaveBeenCalled();
  });

  it('does NOT auto-steal focus on mount (composer focus must not be disrupted)', () => {
    // renderDiffCard must NOT call approve.focus() on mount — not
    // synchronously and not via a deferred callback.  Stealing focus
    // collapses the mobile software keyboard and drops keyboard users
    // on <body> after approve/reject resolves.  Focus is restored by
    // the view layer (resolveApprovalUi in view.ts) after the decision.
    //
    // Strategy: intercept createEl on the parent stub so every button
    // the card creates has its focus() pre-spied.  This catches both
    // synchronous calls and deferred window.setTimeout callbacks.
    const focusCalls: string[] = [];
    const parent = makeEl();
    const origCreateEl = parent.createEl.bind(parent);
    parent.createEl = (tag2: string, opts?: { cls?: string; attr?: Record<string, string> }) => {
      const child = origCreateEl(tag2, opts);
      const label = opts?.attr?.['aria-label'] ?? '';
      const origFocus = child.focus.bind(child);
      child.focus = () => {
        focusCalls.push(label || tag2);
        origFocus();
      };
      return child;
    };

    vi.useFakeTimers();
    try {
      renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
        onApprove: vi.fn(),
        onReject: vi.fn(),
      });
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }

    expect(focusCalls).toHaveLength(0);
  });
});

describe('renderDiffCard: data-tool-use-id binding', () => {
  it('card carries data-tool-use-id matching the proposal', () => {
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const card = parent.children[0];
    expect(card.attrs['data-tool-use-id']).toBe(PROPOSAL.toolUseId);
  });
});
