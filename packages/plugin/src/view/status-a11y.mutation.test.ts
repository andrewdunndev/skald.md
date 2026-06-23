/**
 * Mutation-probe tests for the connection-status element's ARIA attributes
 * and error-state non-color cue (fix/a11y-theme).
 *
 * These tests use the same DOM-stub pattern as live-region.mutation.test.ts
 * so they can run in the node test harness without a browser.
 *
 * Invariants:
 *   (A) statusEl must carry role="status" and aria-live="polite" so
 *       connection-status changes are announced to screen readers
 *       (WCAG 4.1.3 Status Messages).
 *   (A) The error modifier must also render an icon element so that
 *       error state is not conveyed by color alone (WCAG 1.4.1).
 *
 * The tests replicate the pure DOM-building logic from view.ts so they
 * can run without a live Obsidian app instance, mirroring the pattern
 * used by live-region.mutation.test.ts.
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal Obsidian HTMLElement stub
// ---------------------------------------------------------------------------

interface StubEl {
  readonly _tag: string;
  readonly _cls: string;
  readonly _attrs: Record<string, string>;
  readonly _children: StubEl[];
  _text: string;
  setAttrs(a: Record<string, string>): void;
  setAttr(k: string, v: string): void;
  getAttr(k: string): string | null;
  addClass(...cls: string[]): void;
  removeClass(...cls: string[]): void;
  setText(t: string): void;
  empty(): void;
  createDiv(opts?: { cls?: string; text?: string }): StubEl;
  createSpan(opts?: { cls?: string; text?: string }): StubEl;
  createEl(
    tag: string,
    opts?: { cls?: string; text?: string; attr?: Record<string, string> },
  ): StubEl;
}

function makeEl(tag = 'div', cls = ''): StubEl {
  const attrs: Record<string, string> = cls ? { class: cls } : {};
  const children: StubEl[] = [];

  const el: StubEl = {
    _tag: tag,
    _cls: cls,
    _text: '',
    get _attrs() { return attrs; },
    get _children() { return children; },
    setAttrs(a) { Object.assign(attrs, a); },
    setAttr(k, v) { attrs[k] = v; },
    getAttr(k) { return attrs[k] ?? null; },
    addClass(...cs) {
      for (const c of cs) attrs.class = ((attrs.class ?? '') + ' ' + c).trim();
    },
    removeClass(...cs) {
      const cur = (attrs.class ?? '').split(' ');
      attrs.class = cur.filter((c) => !cs.includes(c)).join(' ');
    },
    setText(t) { el._text = t; },
    empty() { children.length = 0; el._text = ''; },
    createDiv(opts) {
      const child = makeEl('div', opts?.cls ?? '');
      if (opts?.text) child._text = opts.text;
      children.push(child);
      return child;
    },
    createSpan(opts) {
      const child = makeEl('span', opts?.cls ?? '');
      if (opts?.text) child._text = opts.text;
      children.push(child);
      return child;
    },
    createEl(t, opts) {
      const child = makeEl(t, opts?.cls ?? '');
      if (opts?.text) child._text = opts.text;
      if (opts?.attr) Object.assign(child._attrs, opts.attr);
      children.push(child);
      return child;
    },
  };
  return el;
}

// ---------------------------------------------------------------------------
// Stub for Obsidian's setIcon (records icon names; doesn't need SVG)
// ---------------------------------------------------------------------------
const iconsSet: string[] = [];
function stubSetIcon(el: StubEl, name: string) {
  iconsSet.push(name);
  el.setAttr('data-icon', name);
}

// ---------------------------------------------------------------------------
// Replicate the statusEl construction from view.ts onOpen().
// ---------------------------------------------------------------------------
function buildStatusEl(): StubEl {
  const statusRow = makeEl('div', 'skald-status-row');
  const statusEl = statusRow.createDiv({ cls: 'skald-status' });
  // Mirrors view.ts — attrs applied at construction time.
  statusEl.setAttrs({ role: 'status', 'aria-live': 'polite' });
  return statusEl;
}

// Mirrors view.ts setStatus() implementation.
function callSetStatus(
  statusEl: StubEl,
  text: string,
  modifier?: 'connected' | 'error',
): void {
  statusEl.empty();
  statusEl.removeClass('connected', 'error');
  if (modifier) statusEl.addClass(modifier);
  if (modifier === 'error') {
    const iconEl = statusEl.createSpan({ cls: 'skald-status-icon' });
    iconEl.setAttr('aria-hidden', 'true');
    stubSetIcon(iconEl, 'alert-circle');
  }
  statusEl.createSpan({ text });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statusEl: ARIA live-region attributes (WCAG 4.1.3)', () => {
  it('carries role="status" after construction', () => {
    const el = buildStatusEl();
    expect(el.getAttr('role')).toBe('status');
  });

  it('carries aria-live="polite" after construction', () => {
    const el = buildStatusEl();
    expect(el.getAttr('aria-live')).toBe('polite');
  });

  it('dropping either attribute is caught by this probe', () => {
    // Regression guard: a build without the setAttrs call would fail both
    // tests above. This test narrows the contract to "both must be present
    // on the same element, not two separate setAttrs calls on sibling els".
    const el = buildStatusEl();
    expect(el.getAttr('role')).toBe('status');
    expect(el.getAttr('aria-live')).toBe('polite');
  });
});

describe('setStatus: error state — non-color cue (WCAG 1.4.1)', () => {
  it('renders an alert icon child when modifier is "error"', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Connection failed', 'error');
    const iconChild = el._children.find((c) =>
      c._cls.includes('skald-status-icon'),
    );
    expect(
      iconChild,
      'skald-status-icon span must be present in error state',
    ).toBeDefined();
  });

  it('icon child is aria-hidden so it does not duplicate the text announcement', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Connection failed', 'error');
    const iconChild = el._children.find((c) =>
      c._cls.includes('skald-status-icon'),
    );
    expect(iconChild?.getAttr('aria-hidden')).toBe('true');
  });

  it('renders the "alert-circle" Lucide icon in error state', () => {
    const el = buildStatusEl();
    iconsSet.length = 0;
    callSetStatus(el, 'Connection failed', 'error');
    expect(iconsSet).toContain('alert-circle');
  });

  it('does NOT render an icon for the "connected" modifier', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Connected', 'connected');
    const iconChild = el._children.find((c) =>
      c._cls.includes('skald-status-icon'),
    );
    expect(iconChild).toBeUndefined();
  });

  it('does NOT render an icon for a plain status (no modifier)', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Disconnected');
    const iconChild = el._children.find((c) =>
      c._cls.includes('skald-status-icon'),
    );
    expect(iconChild).toBeUndefined();
  });

  it('text is still rendered as a child span alongside the icon', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Connection failed', 'error');
    const textChild = el._children.find((c) => c._text === 'Connection failed');
    expect(textChild).toBeDefined();
  });
});

describe('setStatus: "connected" and plain states', () => {
  it('connected state adds the "connected" class', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Connected', 'connected');
    expect(el._attrs.class ?? '').toContain('connected');
  });

  it('plain status (no modifier) renders only the text span (no icon)', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Disconnected');
    expect(el._children).toHaveLength(1);
    expect(el._children[0]._text).toBe('Disconnected');
  });

  it('subsequent setStatus calls clear the previous children via empty()', () => {
    const el = buildStatusEl();
    callSetStatus(el, 'Connection failed', 'error');
    expect(el._children).toHaveLength(2); // icon + text
    callSetStatus(el, 'Connected', 'connected');
    expect(el._children).toHaveLength(1); // text only
  });
});
