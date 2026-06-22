/**
 * Mutation-probe tests for LiveRegion's aria-live DOM attributes.
 *
 * The existing live-region.test.ts deliberately skips the DOM mechanics
 * of LiveRegion (see its header comment) because the harness runs in
 * node with no jsdom. That leaves the aria-live/role/aria-atomic setAttrs
 * call completely untested: dropping `aria-live: 'polite'` from the
 * constructor is a SURVIVOR (all prior tests pass).
 *
 * This file plugs that gap by building a minimal stub of the Obsidian
 * HTMLElement surface (createDiv + setAttrs) directly in node. The stub
 * records the attributes passed to setAttrs so we can assert the
 * accessibility contract without a browser. Obsidian's createDiv is a
 * method on every HTMLElement; we stub the parent element so LiveRegion
 * can construct normally.
 *
 * Invariant tested: LiveRegion MUST set aria-live="polite" and role="log"
 * on its container element. Without both, a screen reader either doesn't
 * announce the element at all (missing aria-live) or announces it with
 * the wrong semantics (wrong role).
 */

import { describe, expect, it } from 'vitest';
import { LiveRegion } from './live-region';

/**
 * Minimal Obsidian HTMLElement stub sufficient for LiveRegion construction.
 * Records every attribute passed to setAttrs so tests can inspect them.
 */
function makeParentStub(): {
  parent: ConstructorParameters<typeof LiveRegion>[0];
  capturedAttrs: Record<string, string>[];
  capturedText: string[];
} {
  const capturedAttrs: Record<string, string>[] = [];
  const capturedText: string[] = [];

  function makeEl(): HTMLElement {
    const attrs: Record<string, string> = {};
    const children: HTMLElement[] = [];

    const el = {
      setAttrs(a: Record<string, string>) {
        capturedAttrs.push({ ...a });
        Object.assign(attrs, a);
      },
      setAttr(k: string, v: string) {
        attrs[k] = v;
      },
      getAttr(k: string) {
        return attrs[k] ?? null;
      },
      createDiv(opts?: { cls?: string; text?: string }) {
        const child = makeEl();
        if (opts?.text) capturedText.push(opts.text);
        children.push(child);
        return child;
      },
      empty() {
        children.length = 0;
      },
      _attrs: attrs,
      _children: children,
    } as unknown as HTMLElement;

    return el;
  }

  const parent = makeEl();
  return { parent, capturedAttrs, capturedText };
}

describe('LiveRegion: aria-live + role DOM attributes', () => {
  it('sets aria-live="polite" on the container element', () => {
    const { parent, capturedAttrs } = makeParentStub();
    new LiveRegion(parent);
    // At least one setAttrs call must include aria-live=polite.
    const found = capturedAttrs.some((a) => a['aria-live'] === 'polite');
    expect(found, 'aria-live="polite" must be set on the live region element').toBe(true);
  });

  it('sets role="log" on the container element', () => {
    const { parent, capturedAttrs } = makeParentStub();
    new LiveRegion(parent);
    const found = capturedAttrs.some((a) => a['role'] === 'log');
    expect(found, 'role="log" must be set on the live region element').toBe(true);
  });

  it('sets aria-atomic="false" so individual appended turns are announced separately', () => {
    const { parent, capturedAttrs } = makeParentStub();
    new LiveRegion(parent);
    const found = capturedAttrs.some((a) => a['aria-atomic'] === 'false');
    expect(found, 'aria-atomic="false" must be set').toBe(true);
  });

  it('sets aria-relevant="additions text" so only new children trigger announcements', () => {
    const { parent, capturedAttrs } = makeParentStub();
    new LiveRegion(parent);
    const found = capturedAttrs.some((a) => a['aria-relevant'] === 'additions text');
    expect(found, 'aria-relevant="additions text" must be set').toBe(true);
  });

  it('announce() appends non-empty text as a child div', () => {
    const { parent, capturedText } = makeParentStub();
    const region = new LiveRegion(parent);
    region.announce('hello world');
    expect(capturedText).toContain('hello world');
  });

  it('announce() ignores empty / whitespace-only text (no blank utterances)', () => {
    const { parent, capturedText } = makeParentStub();
    const region = new LiveRegion(parent);
    region.announce('   ');
    region.announce('');
    expect(capturedText).toHaveLength(0);
  });
});
