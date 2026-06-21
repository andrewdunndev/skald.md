/**
 * Pure helpers used by capture.ts — filename slugification, base64
 * decoding, URL decoding. Kept here so capture.ts stays focused on
 * the service-class orchestration.
 */

/** Generate a vault-safe filename for a captured note. Strips path
 *  separators + `..` (defense in depth against malformed titles from
 *  Apple Shortcuts). Falls back to a timestamp when the title yields
 *  nothing slug-worthy.
 *
 *  When `withTime` is true, the HH-MM-SS component of `now` is appended
 *  to the slug to produce a unique filename on same-day, same-title-slug
 *  collisions. Used by the collision-retry path in CaptureService.run(). */
export function captureFilename(
  captureFolder: string,
  title: string | null,
  now: Date = new Date(),
  withTime = false,
): string {
  const dateStr = now.toISOString().slice(0, 10);
  const baseSlug =
    slugify(title ?? '', 40) ||
    'capture-' + now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const timeSuffix = withTime
    ? '-' + now.toISOString().replace(/[:.]/g, '-').slice(11, 19)
    : '';
  const slug = baseSlug + timeSuffix;
  const folder = captureFolder.replace(/\/$/, '');
  return folder ? `${folder}/${dateStr}-${slug}.md` : `${dateStr}-${slug}.md`;
}

function slugify(text: string, max = 40): string {
  // Replace path separators + `..` with whitespace BEFORE the
  // character-class strip so "foo/../bar" yields "foo-bar" rather
  // than collapsing to "foobar". Defense in depth.
  return text
    .toLowerCase()
    .replace(/\.\.+/g, ' ')
    .replace(/[/\\]+/g, ' ')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

/** Base64 decode a UTF-8 payload. atob returns a binary string;
 *  re-interpret as UTF-8 so multi-byte chars (é, em-dash, emoji)
 *  round-trip correctly. */
export function safeAtob(s: string): string {
  try {
    const binary = atob(s);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

export function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
