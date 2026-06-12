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

  it('warns for any non-empty unrecognized string (e.g. future "remote" mode)', () => {
    resolveConnectionMode('future-mode-v3');
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('modeCapabilities: direct mode', () => {
  it('has semanticSearch = false', () => {
    expect(modeCapabilities('direct').semanticSearch).toBe(false);
  });

  it('has usesWorker = false', () => {
    expect(modeCapabilities('direct').usesWorker).toBe(false);
  });

  it('has banner = "direct"', () => {
    expect(modeCapabilities('direct').banner).toBe('direct');
  });
});

describe('modeCapabilities: worker mode', () => {
  it('has semanticSearch = true', () => {
    expect(modeCapabilities('worker').semanticSearch).toBe(true);
  });

  it('has usesWorker = true', () => {
    expect(modeCapabilities('worker').usesWorker).toBe(true);
  });

  it('has banner = "worker"', () => {
    expect(modeCapabilities('worker').banner).toBe('worker');
  });
});

describe('modeCapabilities: round-trip resolve then lookup', () => {
  it('direct resolves and has correct capabilities', () => {
    const mode = resolveConnectionMode('direct');
    const caps = modeCapabilities(mode);
    expect(caps.semanticSearch).toBe(false);
    expect(caps.usesWorker).toBe(false);
  });

  it('worker resolves and has correct capabilities', () => {
    const mode = resolveConnectionMode('worker');
    const caps = modeCapabilities(mode);
    expect(caps.semanticSearch).toBe(true);
    expect(caps.usesWorker).toBe(true);
  });
});
