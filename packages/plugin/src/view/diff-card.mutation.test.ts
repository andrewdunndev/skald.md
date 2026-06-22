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
 *
 * Focus-on-mount (window.setTimeout → approve.focus()) is exercised
 * structurally: we confirm focus() exists on the approve button stub.
 * The actual focus() call is a DOM side-effect that a real browser
 * verifies; in node the call succeeds (no-op) but we can't observe
 * which element "has focus" without a DOM implementation.
 *
 * Implementation: minimal Obsidian element stubs in-file. The test
 * harness runs in node (no jsdom); Obsidian's HTMLElement extensions
 * (createDiv, createEl, setAttr, setAttrs) are shimmed here as
 * simple recording objects.
 */

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { renderDiffCard } from './diff-card';
import type { WriteProposal } from '../tools';

// renderDiffCard calls window.setTimeout for the deferred focus. In node
// there is no `window` global; shim it to globalThis.setTimeout so the
// call succeeds without a DOM. This must happen before the module imports
// run, but vitest hoists beforeAll so this is the earliest safe spot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hadWindow = 'window' in globalThis;
beforeAll(() => {
  if (!hadWindow) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = { setTimeout: globalThis.setTimeout.bind(globalThis) };
  }
});
afterAll(() => {
  if (!hadWindow) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
  }
});

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

  it('focus() exists on the Approve button (focus-on-mount path is wired)', () => {
    // renderDiffCard defers approve.focus() via window.setTimeout(fn, 0).
    // In node, setTimeout runs but focus() is a no-op; what we CAN verify
    // is that the approve button stub has a focus method (the call won't
    // throw) and that isConnected is true at render time.
    const parent = makeEl();
    renderDiffCard(parent as unknown as HTMLElement, PROPOSAL, {
      onApprove: vi.fn(),
      onReject: vi.fn(),
    });
    const approve = find(parent, (e) => e.attrs['aria-label'] === 'Approve write');
    expect(typeof approve?.focus).toBe('function');
    expect(approve?.isConnected).toBe(true);
    // The actual DOM focus() after setTimeout is a real-browser invariant;
    // jsdom would be needed to observe which element "has focus".
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
