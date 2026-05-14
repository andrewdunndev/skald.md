import { AbstractInputSuggest, App, TFolder } from 'obsidian';

/**
 * Obsidian autocomplete attached to an input element that suggests
 * vault folders as the user types. Tap a suggestion to fill the
 * input. Used for any path-shaped setting (chats folder, saved-notes
 * folder, harness folder, etc.) so users don't have to remember /
 * type the path.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private readonly inputEl: HTMLInputElement;
  private readonly onPick: (folder: TFolder) => void;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onPick: (folder: TFolder) => void,
  ) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.onPick = onPick;
  }

  override getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    const all: TFolder[] = [];
    const walk = (folder: TFolder): void => {
      // Skip the synthetic root (path === "") so "/" doesn't appear
      // in the list when the user hasn't typed anything yet.
      if (folder.path) all.push(folder);
      for (const child of folder.children) {
        if (child instanceof TFolder) walk(child);
      }
    };
    walk(this.app.vault.getRoot());
    return all
      .filter((f) => f.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 12);
  }

  override renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.createSpan({ text: folder.path });
  }

  override selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.trigger('input');
    this.onPick(folder);
    this.close();
  }
}
