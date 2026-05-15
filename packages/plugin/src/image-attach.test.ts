import { describe, expect, it } from 'vitest';
import {
  humanByteCount,
  toImageContentBlock,
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
