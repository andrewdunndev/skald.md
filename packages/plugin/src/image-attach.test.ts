import { describe, expect, it } from 'vitest';
import {
  humanByteCount,
  toImageContentBlock,
  attachmentsFromFiles,
  MAX_IMAGES_PER_TURN,
  type ImageAttachment,
} from './image-attach';

describe('humanByteCount', () => {
  it('renders bytes < 1KB in bytes', () => {
    expect(humanByteCount(0)).toBe('0 B');
    expect(humanByteCount(512)).toBe('512 B');
    expect(humanByteCount(1023)).toBe('1023 B');
  });

  it('renders KB without decimal when >= 1KB and < 1MB', () => {
    expect(humanByteCount(1024)).toBe('1 KB');
    expect(humanByteCount(1500)).toBe('1 KB');
    expect(humanByteCount(2048)).toBe('2 KB');
    expect(humanByteCount(1048575)).toBe('1024 KB');
  });

  it('renders MB with one decimal at >= 1MB', () => {
    expect(humanByteCount(1048576)).toBe('1.0 MB');
    expect(humanByteCount(1572864)).toBe('1.5 MB');
    expect(humanByteCount(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('toImageContentBlock', () => {
  it('produces an Anthropic-canonical image content block from an attachment', () => {
    const att: ImageAttachment = {
      id: 'att1',
      mediaType: 'image/png',
      label: 'screenshot.png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQ',
      byteLength: 24,
    };
    expect(toImageContentBlock(att)).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQ',
      },
    });
  });

  it('preserves the original media type (jpeg, gif, webp variants)', () => {
    for (const mediaType of [
      'image/jpeg',
      'image/gif',
      'image/webp',
    ] as const) {
      const att: ImageAttachment = {
        id: 'x',
        mediaType,
        label: 'img',
        base64: 'AAAA',
        byteLength: 4,
      };
      const block = toImageContentBlock(att) as {
        source: { media_type: string };
      };
      expect(block.source.media_type).toBe(mediaType);
    }
  });
});

describe('MAX_IMAGES_PER_TURN cap', () => {
  it('is exported and equals 20 (OpenRouter combined-images limit)', () => {
    expect(MAX_IMAGES_PER_TURN).toBe(20);
  });

  it('attachmentsFromFiles returns at most MAX_IMAGES_PER_TURN attachments', async () => {
    // Build MAX_IMAGES_PER_TURN + 2 tiny PNGs (valid 1×1 PNG bytes).
    // Node 18+ has File, Blob, crypto.randomUUID, and btoa so this
    // exercises the real codepath without DOM stubs.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // width=1, height=1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // bit depth, color, compress, filter, interlace, CRC
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT length + type
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // IDAT data
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // IDAT data
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND length + type
      0x44, 0xae, 0x42, 0x60, 0x82,                   // IEND CRC
    ]);
    const overCount = MAX_IMAGES_PER_TURN + 2;
    const files: File[] = Array.from({ length: overCount }, (_, i) =>
      new File([pngBytes], `img-${i}.png`, { type: 'image/png' }),
    );
    const atts = await attachmentsFromFiles(files);
    expect(atts.length).toBe(MAX_IMAGES_PER_TURN);
  });
});

