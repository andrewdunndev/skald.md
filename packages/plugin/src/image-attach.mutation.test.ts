/**
 * Mutation-probe tests for image-attach.ts guards.
 *
 * Two survivors found during probe:
 *
 * 1. MAX_IMAGES_PER_TURN BEHAVIORAL CAP SURVIVOR
 *    The existing test asserts `atts.length <= MAX_IMAGES_PER_TURN` using
 *    the exported constant. If MAX_IMAGES_PER_TURN is raised (e.g. to 10000),
 *    22 images go through and the existing test still passes because it
 *    compares against the (now-mutated) constant, not the literal 20.
 *    Fix: test against the hard literal 20, which is the OpenRouter limit.
 *
 * 2. OVERSIZE GIF REJECTION SURVIVOR
 *    The existing tests never supply an oversize GIF. Bypassing the
 *    `blob.type === 'image/gif'` branch entirely produces no test failure.
 *    The specific behavior tested here: notifyOversizeSkip (which calls
 *    console.warn) fires with the GIF-specific reason string when an
 *    oversize GIF is submitted. If the GIF guard were removed, the GIF
 *    would fall into compressImageBlob (which throws in node), be caught,
 *    and be silently dropped WITHOUT the console.warn — a different failure
 *    mode that matters for user-visible feedback. The warn spy catches this.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { attachmentsFromFiles, MAX_IMAGES_PER_TURN } from './image-attach';

// ---------------------------------------------------------------------------
// Shared fixture: minimal valid 1×1 PNG (under MAX_IMAGE_BYTES)
// ---------------------------------------------------------------------------

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

// ---------------------------------------------------------------------------
// Guard 1: MAX_IMAGES_PER_TURN behavioral hard cap at literal 20
// ---------------------------------------------------------------------------

describe('MAX_IMAGES_PER_TURN: behavioral hard cap at literal 20', () => {
  it('constant is exactly 20 (OpenRouter combined-images limit)', () => {
    // Pin the literal value so raising the constant is caught here even
    // before the behavioral assertion below.
    expect(MAX_IMAGES_PER_TURN).toBe(20);
  });

  it('attachmentsFromFiles caps at exactly 20, not at whatever MAX_IMAGES_PER_TURN happens to be', async () => {
    // Build 23 small PNGs — clearly over the 20 limit.
    const OVER = 23;
    const files: File[] = Array.from({ length: OVER }, (_, i) =>
      new File([TINY_PNG], `img-${i}.png`, { type: 'image/png' }),
    );
    const atts = await attachmentsFromFiles(files);
    // Assert against the hard literal 20, NOT the exported constant.
    // If MAX_IMAGES_PER_TURN were raised to 10000, this still catches the
    // regression because the cap in blobsToAttachments uses the constant
    // and 23 blobs would now all succeed.
    expect(atts.length).toBe(20);
  });

  it('exactly 20 images all attach (cap is inclusive at 20)', async () => {
    const files: File[] = Array.from({ length: 20 }, (_, i) =>
      new File([TINY_PNG], `img-${i}.png`, { type: 'image/png' }),
    );
    const atts = await attachmentsFromFiles(files);
    expect(atts.length).toBe(20);
  });

  it('the 21st image is dropped (cap triggers on >= 20)', async () => {
    const files: File[] = Array.from({ length: 21 }, (_, i) =>
      new File([TINY_PNG], `img-${i}.png`, { type: 'image/png' }),
    );
    const atts = await attachmentsFromFiles(files);
    expect(atts.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: oversize GIF rejection — asserted via console.warn spy
//
// The GIF guard calls notifyOversizeSkip() which always calls console.warn
// with the GIF-specific reason. If the guard is bypassed (mutation: the
// `blob.type === 'image/gif'` check removed), the GIF falls into
// compressImageBlob (Canvas not available in node), throws, and is silently
// caught — console.warn is NOT called. The spy distinguishes these paths.
// ---------------------------------------------------------------------------

const OVER_4MB = 4 * 1024 * 1024 + 1;
// Oversize GIF fixture: large enough to exceed MAX_IMAGE_BYTES; type= on
// File sets blob.type to image/gif regardless of content bytes.
const OVERSIZE_GIF_BYTES = new Uint8Array(OVER_4MB);
// GIF89a magic for self-documentation.
OVERSIZE_GIF_BYTES.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a

describe('oversize GIF rejection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a GIF-specific warning via console.warn when oversize GIF is rejected', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = new File([OVERSIZE_GIF_BYTES], 'anim.gif', { type: 'image/gif' });

    expect(file.size).toBeGreaterThan(4 * 1024 * 1024);
    await attachmentsFromFiles([file]);

    // notifyOversizeSkip calls console.warn with the rejection reason.
    // If the GIF guard (`blob.type === 'image/gif'`) is removed, the GIF
    // falls into compressImageBlob which throws silently — no warn is called.
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0]?.[0] ?? '';
    expect(typeof warnArg).toBe('string');
    expect(warnArg).toContain('GIF compression would drop animation frames');
  });

  it('rejects an oversize GIF and returns an empty array', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = new File([OVERSIZE_GIF_BYTES], 'anim.gif', { type: 'image/gif' });
    const atts = await attachmentsFromFiles([file]);
    expect(atts).toHaveLength(0);
  });

  it('an oversize GIF mixed with a small valid PNG: only the PNG attaches', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const small = new File([TINY_PNG], 'small.png', { type: 'image/png' });
    const gif = new File([OVERSIZE_GIF_BYTES], 'anim.gif', { type: 'image/gif' });

    const atts = await attachmentsFromFiles([small, gif]);
    expect(atts).toHaveLength(1);
    expect(atts[0].mediaType).toBe('image/png');
  });
});
