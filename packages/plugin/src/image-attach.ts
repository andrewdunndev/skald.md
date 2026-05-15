/**
 * Image attachment helpers (phase 7 — vision).
 *
 * Vision is shipped paste-only on desktop for v1: when the user
 * pastes an image into the chat input, we convert the clipboard
 * data into an Anthropic-canonical image content block
 * ({type: 'image', source: {type: 'base64', media_type, data}}).
 *
 * Camera / Photos pickers on iOS and a vault-image entry via the
 * @-picker land in subsequent phase 7 sub-features. Paste already
 * covers the desktop demo and is the cheapest exemplary v1.
 *
 * Vision is per-model: the underlying model must support image
 * inputs (Anthropic, OpenAI, Google, xAI, MoonshotAI families on
 * OpenRouter). If a non-vision model is selected, the upstream
 * provider returns an error which the existing transport surfaces
 * verbatim — we don't pre-gate on capability since the catalog
 * metadata isn't always loaded.
 */

import type { ContentBlock } from '@scribian/protocol';

export type ImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

const SUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** ~5MB raw, comfortably under Anthropic's per-image cap. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * One image attached to the in-flight user turn. Held in plugin
 * state while the user composes their message; consumed by
 * `toImageContentBlock` on send and discarded.
 */
export interface ImageAttachment {
  /** Stable id used for chip removal + content-block alignment. */
  id: string;
  /** MIME type recognized by Anthropic + OpenRouter. */
  mediaType: ImageMediaType;
  /** Friendly label rendered in the chip (filename if known, else
   * "pasted image"). */
  label: string;
  /** Raw bytes, base64-encoded for transport (kept off the
   * critical path on attach time so the encode is amortized
   * with paste handling). */
  base64: string;
  /** Byte length of the original (pre-base64) blob, for the
   * cost-estimate chip caption. */
  byteLength: number;
}

/** True when the clipboard event carries a usable image. */
export function clipboardHasImage(e: ClipboardEvent): boolean {
  const items = e.clipboardData?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    if (SUPPORTED_MEDIA_TYPES.has(items[i].type)) return true;
  }
  return false;
}

/**
 * Pull every image out of a clipboard event and return them as
 * ImageAttachment[]. Resolves to an empty array if the clipboard
 * doesn't carry images, an oversize image, or fails to encode.
 */
export async function attachmentsFromClipboard(
  e: ClipboardEvent,
): Promise<ImageAttachment[]> {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const out: ImageAttachment[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!SUPPORTED_MEDIA_TYPES.has(item.type)) continue;
    const blob = item.getAsFile();
    if (!blob || blob.size > MAX_IMAGE_BYTES) continue;
    try {
      out.push(await blobToAttachment(blob));
    } catch {
      // skip unencodable
    }
  }
  return out;
}

async function blobToAttachment(blob: Blob): Promise<ImageAttachment> {
  const buf = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  return {
    id: crypto.randomUUID(),
    mediaType: blob.type as ImageMediaType,
    label:
      (blob as Blob & { name?: string }).name ||
      `pasted ${blob.type.replace('image/', '')}`,
    base64,
    byteLength: blob.size,
  };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Stream the conversion in chunks to avoid call-stack blowup on
  // larger images (String.fromCharCode.apply with the full Uint8Array
  // overflows at ~100k bytes on some runtimes).
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(
      String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + CHUNK)),
      ),
    );
  }
  return btoa(parts.join(''));
}

/**
 * Convert an attachment into the Anthropic-canonical image
 * content block. OpenRouter's `/api/v1/messages` accepts the same
 * shape verbatim per the 2026-05-14 verification (S1).
 */
export function toImageContentBlock(att: ImageAttachment): ContentBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: att.mediaType,
      data: att.base64,
    },
  };
}

/** Pretty byte-count for chip labels. */
export function humanByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
