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

  it('resolves to "direct" for an unrecognized non-empty string (future mode)', () => {
    expect(resolveConnectionMode('remote')).toBe('direct');
  });

  it('emits a console.warn for an unrecognized value (not silent)', () => {
    resolveConnectionMode('remote');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toMatch(/unrecognized.*remote/i);
  });

  it('resolves to "direct" for undefined without warning', () => {
    resolveConnectionMode(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves to "direct" for null without warning', () => {
    resolveConnectionMode(null);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves to "direct" for empty string without warning', () => {
    resolveConnectionMode('');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves to "direct" for numeric values', () => {
    expect(resolveConnectionMode(42)).toBe('direct');
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
