/**
 * @-picker — inline fuzzy-search dropdown that appears when the
 * user types `@` followed by a query. Owns its DOM, state, and
 * input-replacement logic; the host view wires keyboard events
 * + provides the "what to do with a picked file" callback.
 *
 * Extracted from view.ts as part of the LOC-cap refactor: the
 * picker is a self-contained interaction with a clear contract
 * (input watcher + keyboard nav + callback). The view doesn't need
 * to know about pickerAnchor or selectedIdx — those are local state.
 */

import {
  App,
  TFile,
  prepareFuzzySearch,
} from 'obsidian';

export interface NotePickerHooks {
  /** User picked a file. The view decides what to do with it
   * (typically: add to pickedFiles + re-render chips). */
  onPick: (file: TFile) => void;
}

const MAX_RESULTS = 8;

export class NotePicker {
  private pickerEl: HTMLDivElement | null = null;
  private anchor = -1;
  private selectedIdx = 0;
  private results: TFile[] = [];

  constructor(
    private readonly app: App,
    private readonly inputEl: HTMLTextAreaElement,
    /** The picker DOM is inserted after this element. Conventionally
     * the chip row, so the picker sits between chips and input. */
    private readonly insertAfter: HTMLElement,
    private readonly hooks: NotePickerHooks,
  ) {}

  /** True when the picker is rendered AND has at least one result.
   * Used by the view's keyboard handler to decide whether arrow
   * keys / Enter route to the picker or fall through to send. */
  isOpen(): boolean {
    return this.pickerEl !== null && this.results.length > 0;
  }

  /** Inspect the input for an `@query` token ending at the cursor;
   * open/close/re-render the picker accordingly. */
  updateForCursor(): void {
    const text = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const atMatch = before.match(/(^|\s)@([^\s@]*)$/);
    if (!atMatch) {
      this.close();
      return;
    }
    const query = atMatch[2];
    const atIndex = cursor - query.length - 1;
    this.open(atIndex, query);
  }

  moveSelection(delta: 1 | -1): void {
    if (!this.isOpen()) return;
    const n = this.results.length;
    this.selectedIdx = (this.selectedIdx + delta + n) % n;
    this.render();
  }

  /** Apply the currently-selected result. Removes the `@query`
   * substring from the input and fires onPick. */
  acceptSelection(): void {
    const file = this.results[this.selectedIdx];
    if (!file) return;
    const text = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? text.length;
    this.inputEl.value = text.slice(0, this.anchor) + text.slice(cursor);
    this.inputEl.setSelectionRange(this.anchor, this.anchor);
    this.inputEl.focus();
    this.hooks.onPick(file);
    this.close();
  }

  close(): void {
    if (!this.pickerEl) return;
    this.pickerEl.remove();
    this.pickerEl = null;
    this.results = [];
    this.anchor = -1;
    this.selectedIdx = 0;
  }

  // ── internals ─────────────────────────────────────────────────

  private open(atIndex: number, query: string): void {
    this.anchor = atIndex;
    this.results = this.search(query);
    this.selectedIdx = 0;
    if (!this.pickerEl) {
      this.pickerEl = this.insertAfter.insertAdjacentElement(
        'afterend',
        createDiv({ cls: 'scribian-picker' }),
      ) as HTMLDivElement;
    }
    this.render();
  }

  private render(): void {
    if (!this.pickerEl) return;
    this.pickerEl.empty();
    if (this.results.length === 0) {
      this.pickerEl
        .createDiv({ cls: 'scribian-picker-empty' })
        .setText('No matching notes');
      return;
    }
    this.results.forEach((file, idx) => {
      const row = this.pickerEl!.createDiv({
        cls: `scribian-picker-row${idx === this.selectedIdx ? ' is-selected' : ''}`,
      });
      row.createSpan({ cls: 'scribian-picker-name', text: file.basename });
      const folder = file.parent?.path;
      if (folder && folder !== '/') {
        row.createSpan({ cls: 'scribian-picker-folder', text: folder });
      }
      row.addEventListener('click', (e) => {
        e.preventDefault();
        this.selectedIdx = idx;
        this.acceptSelection();
      });
      // Avoid stealing focus from the textarea on mousedown
      row.addEventListener('mousedown', (e) => e.preventDefault());
    });
  }

  private search(query: string): TFile[] {
    const all = this.app.vault.getMarkdownFiles();
    if (!query) {
      return [...all]
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, MAX_RESULTS);
    }
    const fuzzy = prepareFuzzySearch(query);
    const scored: Array<{ file: TFile; score: number }> = [];
    for (const f of all) {
      const result = fuzzy(f.basename) ?? fuzzy(f.path);
      if (result) scored.push({ file: f, score: result.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((s) => s.file);
  }
}
