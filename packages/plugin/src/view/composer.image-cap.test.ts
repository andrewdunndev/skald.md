/**
 * Regression tests for the accumulated image-cap bug (audit P1).
 *
 * Root cause: blobsToAttachments caps per-batch, but Composer
 * accumulated across multiple paste/pick events without rechecking
 * the running total — two 15-image pastes yielded 30 pickedImages,
 * defeating MAX_IMAGES_PER_TURN=20.
 *
 * The fix extracts trimToImageCap as a pure helper; these tests pin
 * the accumulation invariant without requiring the Obsidian DOM.
 */

import { describe, expect, it } from 'vitest';
import { trimToImageCap, MAX_IMAGES_PER_TURN, type ImageAttachment } from '../image-attach';

/** Build a minimal ImageAttachment stub. */
function makeAtt(id: string): ImageAttachment {
  return {
    id,
    mediaType: 'image/png',
    label: `img-${id}.png`,
    base64: 'AAAA',
    byteLength: 4,
  };
}

/** Build n stubs with sequential ids. */
function makeAtts(n: number, prefix = 'a'): ImageAttachment[] {
  return Array.from({ length: n }, (_, i) => makeAtt(`${prefix}${i}`));
}

describe('trimToImageCap — pure accumulation helper', () => {
  it('accepts all images when total stays under cap', () => {
    const { accepted, dropped } = trimToImageCap(5, makeAtts(10));
    expect(accepted).toHaveLength(10);
    expect(dropped).toBe(0);
  });

  it('trims incoming so existing + accepted === MAX_IMAGES_PER_TURN', () => {
    // First paste: 15 images — all accepted
    const batch1 = makeAtts(15, 'x');
    const r1 = trimToImageCap(0, batch1);
    expect(r1.accepted).toHaveLength(15);
    expect(r1.dropped).toBe(0);

    // Second paste: 15 images — only 5 slots remain; 10 must be dropped.
    // This is the exact scenario the bug allowed to pass unchecked.
    const batch2 = makeAtts(15, 'y');
    const r2 = trimToImageCap(r1.accepted.length, batch2);
    expect(r2.accepted).toHaveLength(5);
    expect(r2.dropped).toBe(10);

    // Combined total must not exceed cap.
    expect(r1.accepted.length + r2.accepted.length).toBe(MAX_IMAGES_PER_TURN);
  });

  it('drops all incoming when already at cap', () => {
    const { accepted, dropped } = trimToImageCap(MAX_IMAGES_PER_TURN, makeAtts(3));
    expect(accepted).toHaveLength(0);
    expect(dropped).toBe(3);
  });

  it('accepts exactly up to the cap when incoming exactly fills remaining slots', () => {
    const remaining = 4;
    const { accepted, dropped } = trimToImageCap(
      MAX_IMAGES_PER_TURN - remaining,
      makeAtts(remaining),
    );
    expect(accepted).toHaveLength(remaining);
    expect(dropped).toBe(0);
  });

  it('never returns accepted.length > MAX_IMAGES_PER_TURN - existing', () => {
    // Property: for any combination, accepted never exceeds available slots.
    const cases: Array<[number, number]> = [
      [0, 25],
      [10, 15],
      [19, 5],
      [20, 1],
      [20, 100],
    ];
    for (const [existing, incomingCount] of cases) {
      const { accepted } = trimToImageCap(existing, makeAtts(incomingCount));
      const maxAllowed = Math.max(0, MAX_IMAGES_PER_TURN - existing);
      expect(accepted.length).toBeLessThanOrEqual(maxAllowed);
      expect(existing + accepted.length).toBeLessThanOrEqual(MAX_IMAGES_PER_TURN);
    }
  });
});
