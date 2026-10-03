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
 * provider returns an error — we don't pre-gate on capability since
 * the catalog metadata isn't always loaded. On OpenRouter, provider
 * errors for oversize or unsupported images may be generic (e.g. 400
 * or 413); httpErrorMessage maps these to actionable copy.
 */

import { Notice } from 'obsidian';
import type { ContentBlock } from './protocol';

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

/**
 * Per-image cap, checked against the raw (pre-base64) blob size.
 *
 * The image rides an HTTPS POST to the provider, so the ceiling is the
 * provider's per-image limit. Anthropic's API accepts up to 10 MB
 * base64-encoded per image; base64 inflates raw bytes by ~33%, so the
 * hard raw ceiling is ~7.3 MB. OpenRouter fans out to providers with
 * assorted (often lower) limits, and surfaces their error verbatim if a
 * blob is too large for the chosen backend.
 *
 * We set 4 MB raw: comfortably under Anthropic's ceiling with headroom
 * for base64 + the request envelope, friendly to stricter OpenRouter
 * backends, and large enough that a typical phone photo (2-4 MB) attaches
 * at full fidelity instead of being needlessly downscaled. Note that
 * token cost scales with image DIMENSIONS, not file size (Anthropic
 * resizes anything over ~1568px internally for tokenization), so a larger
 * byte cap does not by itself raise per-image token cost.
 *
 * Source blobs OVER the cap are auto-compressed via `compressImageBlob`
 * (Canvas re-encode to JPEG with progressively smaller dimensions +
 * quality) until they fit. The chip label surfaces the downsize ratio so
 * the user sees what happened. GIFs are an exception — re-encoding kills
 * animation frames — so oversize GIFs are rejected with a Notice.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Per-turn image count ceiling. OpenRouter's combined-images limit is
 * 20 across all providers; Anthropic's own limit is lower (20 per
 * message) but the practical cap here is OpenRouter's combined limit.
 * Exceeding it produces a request-level error before any model sees
 * the payload, so we refuse extras up-front with a visible Notice.
 */
export const MAX_IMAGES_PER_TURN = 20;

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

/**
 * Trim `incoming` so the running total (existing + incoming) stays at
 * or under MAX_IMAGES_PER_TURN. Returns the accepted slice and the
 * number of dropped images.
 *
 * Pure helper — extracted from Composer so the accumulation invariant
 * is unit-testable without the Obsidian DOM.
 */
export function trimToImageCap(
  existing: number,
  incoming: ImageAttachment[],
): { accepted: ImageAttachment[]; dropped: number } {
  const remaining = Math.max(0, MAX_IMAGES_PER_TURN - existing);
  const accepted = incoming.slice(0, remaining);
  const dropped = incoming.length - accepted.length;
  return { accepted, dropped };
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
  const blobs: Blob[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!SUPPORTED_MEDIA_TYPES.has(item.type)) continue;
    const blob = item.getAsFile();
    if (blob) blobs.push(blob);
  }
  return blobsToAttachments(blobs);
}

/**
 * Convert a FileList (from `<input type="file">`) into
 * ImageAttachment[]. Used by the iOS camera + photos picker on
 * mobile and by drag-drop on desktop. Anything that isn't a
 * supported image MIME type is silently dropped.
 */
export async function attachmentsFromFiles(
  files: FileList | File[],
): Promise<ImageAttachment[]> {
  const blobs: Blob[] = [];
  // FileList isn't iterable on all runtimes; index manually.
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (SUPPORTED_MEDIA_TYPES.has(f.type)) blobs.push(f);
  }
  return blobsToAttachments(blobs);
}

async function blobsToAttachments(blobs: Blob[]): Promise<ImageAttachment[]> {
  const out: ImageAttachment[] = [];
  for (const original of blobs) {
    // Enforce per-turn image count cap before processing further blobs.
    // Extras are dropped with a visible Notice; the user sees the cap
    // rather than hitting an opaque provider-level error later.
    if (out.length >= MAX_IMAGES_PER_TURN) {
      new Notice(
        `skald: only ${MAX_IMAGES_PER_TURN} images per message — extra images dropped.`,
        6000,
      );
      break;
    }
    try {
      let blob = original;
      let downsized = false;
      if (blob.size > MAX_IMAGE_BYTES) {
        if (blob.type === 'image/gif') {
          // Canvas re-encoding kills GIF animation frames; reject
          // cleanly so the user knows why nothing attached.
          notifyOversizeSkip(original, 'GIF compression would drop animation frames');
          continue;
        }
        const compressed = await compressImageBlob(blob, MAX_IMAGE_BYTES);
        if (!compressed) {
          notifyOversizeSkip(original, 'could not compress under transit limit');
          continue;
        }
        blob = compressed;
        downsized = true;
      }
      out.push(await blobToAttachment(blob, original, downsized));
    } catch {
      // skip unencodable
    }
  }
  return out;
}

async function blobToAttachment(
  blob: Blob,
  original: Blob,
  downsized: boolean,
): Promise<ImageAttachment> {
  const buf = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const filename = (original as Blob & { name?: string }).name;
  const baseLabel = filename || `pasted ${original.type.replace('image/', '')}`;
  return {
    id: crypto.randomUUID(),
    mediaType: blob.type as ImageMediaType,
    label: downsized
      ? `${baseLabel} (downsized from ${humanByteCount(original.size)})`
      : baseLabel,
    base64,
    byteLength: blob.size,
  };
}

/**
 * Re-encode an oversize image as JPEG, iteratively dropping
 * dimensions + quality until it fits under `targetBytes`. Returns
 * null when even the smallest acceptable encoding still overshoots
 * (rare — usually means an unreadable source). Pure runtime API
 * (Canvas + createImageBitmap) — no unit-testable path; verified
 * on real Obsidian.
 *
 * An oversize photo (say an 8 MB JPEG into the 4 MB target) usually
 * settles in 1-2 iterations at quality ~0.8 + near-full dimensions.
 * Output is always JPEG; alpha channels are
 * lost on transparent PNGs but the vision use cases here (photos,
 * scans, screenshots) don't typically need alpha.
 */
export async function compressImageBlob(
  blob: Blob,
  targetBytes: number,
): Promise<Blob | null> {
  // Some runtimes (older webviews) don't have createImageBitmap;
  // fall back to <img> if needed. Both paths produce a drawable
  // source for the canvas.
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await createImageBitmap(blob);
  } catch {
    source = await blobToImageElement(blob);
  }
  const { width: srcW, height: srcH } = source as { width: number; height: number };

  // Quality + scale schedule: start gentle, then escalate. The
  // schedule is small (5 attempts max) so iPhone photos converge
  // quickly without burning frames.
  const attempts: Array<{ scale: number; quality: number }> = [
    { scale: 1.0, quality: 0.85 },
    { scale: 0.85, quality: 0.8 },
    { scale: 0.7, quality: 0.75 },
    { scale: 0.55, quality: 0.7 },
    { scale: 0.4, quality: 0.65 },
  ];

  for (const { scale, quality } of attempts) {
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
    const out = await canvasToBlob(canvas, 'image/jpeg', quality);
    if (out && out.size <= targetBytes) return out;
  }
  return null;
}

function blobToImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

/** Surface a one-shot Notice when an image is skipped so the user
 * sees the failure path (silent dropping is worse than visible
 * rejection — they tap the camera chip again expecting a different
 * result). The console.warn is the durable trail. */
function notifyOversizeSkip(blob: Blob, reason: string): void {
  const name = (blob as Blob & { name?: string }).name || 'image';
  console.warn(
    `skald: skipped attachment "${name}" (${humanByteCount(blob.size)}): ${reason}.`,
  );
  new Notice(`skald: skipped image (${reason})`, 6000);
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
