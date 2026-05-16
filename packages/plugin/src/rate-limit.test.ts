import { describe, expect, it } from 'vitest';
import { SlidingWindow } from './rate-limit';

describe('SlidingWindow', () => {
  it('admits up to maxEvents within the window', () => {
    const w = new SlidingWindow(3, 1000);
    expect(w.isExceeded(1000)).toBe(false);
    w.record(1000);
    expect(w.isExceeded(1100)).toBe(false);
    w.record(1100);
    expect(w.isExceeded(1200)).toBe(false);
    w.record(1200);
    // Three events recorded, all within the window — now isExceeded
    expect(w.isExceeded(1300)).toBe(true);
  });

  it('expires events past the window edge', () => {
    const w = new SlidingWindow(2, 1000);
    w.record(1000);
    w.record(1500);
    // At t=2100, t=1000 is outside the 1000ms window; only t=1500 counts.
    expect(w.isExceeded(2100)).toBe(false);
  });

  it('expires multiple stale events on a single check', () => {
    const w = new SlidingWindow(3, 1000);
    w.record(100);
    w.record(200);
    w.record(300);
    // Far in the future — all three are stale.
    expect(w.isExceeded(5000)).toBe(false);
    expect(w.size()).toBe(0);
  });

  it('isExceeded prunes in place (size reflects live count)', () => {
    const w = new SlidingWindow(10, 1000);
    w.record(100);
    w.record(200);
    expect(w.size()).toBe(2);
    w.isExceeded(5000); // far future, both expire
    expect(w.size()).toBe(0);
  });

  it('record() does not enforce — caller checks isExceeded first', () => {
    const w = new SlidingWindow(1, 1000);
    w.record(1000);
    w.record(1100); // exceeds, but record() is unconditional
    expect(w.size()).toBe(2);
    expect(w.isExceeded(1200)).toBe(true);
  });

  it('returns false on a fresh instance', () => {
    expect(new SlidingWindow(1, 1000).isExceeded()).toBe(false);
    expect(new SlidingWindow(1, 1000).size()).toBe(0);
  });
});
