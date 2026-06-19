/**
 * Tests for mode-capabilities.ts: resolveConnectionMode and modeCapabilities.
 *
 * resolveConnectionMode: guards at runtime against unknown stored values
 * (forward-compat — a future mode stored by a newer version should not be
 * clobbered on downgrade; it resolves to 'direct' for runtime behavior
 * while the raw string is preserved separately by main.ts).
 *
 * modeCapabilities: exhaustive switch produces the correct capability
 * descriptor for each known mode.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveConnectionMode, modeCapabilities } from './mode-capabilities';

describe('resolveConnectionMode: known values', () => {
  it('returns "direct" for stored "direct"', () => {
    expect(resolveConnectionMode('direct')).toBe('direct');
  });

  it('returns "worker" for stored "worker"', () => {
    expect(resolveConnectionMode('worker')).toBe('worker');
  });
});

describe('resolveConnectionMode: unknown values — downgrade safety', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits a console.warn for an unrecognized value (not silent)', () => {
    resolveConnectionMode('remote');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/unrecognized.*remote/i);
  });

  // Every non-known value resolves to 'direct'. Absent/empty inputs
  // (undefined/null/'') resolve silently — those are normal "not set yet"
  // states. Any other unrecognized value (a future mode string, or a
  // wrong-typed value) warns: it's a real value we don't understand and
  // deliberately preserve on save, so the warn flags it.
  // FAILS under mutation "resolveConnectionMode returns the raw value" — the
  // toBe('direct') column catches it for every input.
  it.each([
    ['unrecognized string (future mode)', 'remote', true],
    ['numeric value', 42, true],
    ['undefined', undefined, false],
    ['null', null, false],
    ['empty string', '', false],
  ])('resolves "%s" to "direct" (warns=%s)', (_label, input, warns) => {
    expect(resolveConnectionMode(input as never)).toBe('direct');
    if (warns) {
      expect(warnSpy).toHaveBeenCalledOnce();
    } else {
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });
});

describe('modeCapabilities', () => {
  it('direct mode: no semantic search, no worker, direct banner', () => {
    expect(modeCapabilities('direct')).toEqual({
      semanticSearch: false,
      usesWorker: false,
      banner: 'direct',
    });
  });

  it('worker mode: semantic search, worker transport, worker banner', () => {
    expect(modeCapabilities('worker')).toEqual({
      semanticSearch: true,
      usesWorker: true,
      banner: 'worker',
    });
  });
});
