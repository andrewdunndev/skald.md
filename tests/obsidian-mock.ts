/**
 * Minimal 'obsidian' mock for unit tests. Only the surface the pure
 * scribian modules actually use is implemented; anything else throws
 * so a test inadvertently relying on an unmocked API fails loudly
 * rather than silently passing.
 *
 * Keep this file lean. If a test needs a richer obsidian fake, the
 * module under test is probably not pure enough to live in this test
 * suite — move it into an integration test once that surface exists.
 */

export class TFile {
  constructor(
    public path: string,
    public basename: string = path.replace(/\.md$/, '').split('/').pop() ?? path,
    public extension: string = path.split('.').pop() ?? '',
    public stat: { mtime: number; ctime: number; size: number } = {
      mtime: 0,
      ctime: 0,
      size: 0,
    },
  ) {}
}

export class TFolder {
  public children: Array<TFile | TFolder> = [];
  constructor(public path: string) {}
}

/** Mirrors Obsidian's `normalizePath` for the purposes of pure
 * tests — collapses slashes + strips trailing slash. */
export function normalizePath(p: string): string {
  return p.replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
}

/**
 * Thin stand-in for Obsidian's prepareFuzzySearch — good enough for
 * unit tests that assert "matched non-zero / didn't match." Returns
 * a score proportional to consecutive substring matches; null on no
 * match. Doesn't try to replicate Obsidian's actual scoring math.
 */
export function prepareFuzzySearch(
  query: string,
): (haystack: string) => { score: number; matches: number[][] } | null {
  const q = query.toLowerCase().trim();
  return (hay) => {
    if (!q) return null;
    const h = hay.toLowerCase();
    if (!h.includes(q)) return null;
    return { score: q.length * (h.indexOf(q) === 0 ? 2 : 1), matches: [] };
  };
}

// Type-only placeholders for modules that import App / SuggestModal /
// AbstractInputSuggest — they won't be instantiated in unit tests so
// runtime shape doesn't matter.
export class App {}
export class SuggestModal<T> {
  constructor(_app: App) {
    void _app;
    void this;
  }
  setPlaceholder(_s: string): this { return this; }
  setInstructions(_i: unknown[]): this { return this; }
  open(): void {}
}
export class AbstractInputSuggest<T> {
  constructor(_app: App, _input: HTMLInputElement) {
    void _app;
    void _input;
    void this;
  }
}
export class Modal {
  contentEl: HTMLElement = {} as HTMLElement;
  constructor(_app: App) {
    void _app;
    void this;
  }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}
export function setIcon(_el: HTMLElement, _icon: string): void {
  void _el;
  void _icon;
}
export function setTooltip(_el: HTMLElement, _text: string): void {
  void _el;
  void _text;
}
export class Notice {
  constructor(_msg: string, _ttl?: number) {
    void _msg;
    void _ttl;
  }
  setMessage(_m: string): void {}
  hide(): void {}
}
