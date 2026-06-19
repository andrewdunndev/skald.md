import { App, TFile, setIcon, setTooltip, type EventRef } from 'obsidian';

export interface ActiveNoteHooks {
  /** Called when the user taps the attach button. Host should push
   * the file into the composer's picked-files set so the next
   * turn includes it in the <context> envelope. */
  onAttach: (file: TFile) => void;
}

/**
 * Small header chip that surfaces the user's currently-active vault
 * note so the user knows at a glance what Claude DOESN'T see unless
 * they attach it. One-tap attach (paperclip button) pushes the file
 * into the composer's picked-files set — same code path as @-attach
 * but without typing the path.
 *
 * Subscribes to workspace.on('file-open') so the chip updates as the
 * user navigates around the vault. dispose() unregisters the listener;
 * caller is responsible for invoking it on view close.
 */
export class ActiveNoteIndicator {
  private readonly wrapEl: HTMLDivElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly attachBtn: HTMLButtonElement;
  private readonly subscription: EventRef;
  private current: TFile | null = null;

  constructor(
    parent: HTMLElement,
    private readonly app: App,
    private readonly hooks: ActiveNoteHooks,
  ) {
    this.wrapEl = parent.createDiv({ cls: 'skald-active-note' });
    const icon = this.wrapEl.createSpan({ cls: 'skald-active-note-icon' });
    setIcon(icon, 'file-text');
    this.labelEl = this.wrapEl.createSpan({
      cls: 'skald-active-note-label',
    });
    this.attachBtn = this.wrapEl.createEl('button', {
      cls: 'clickable-icon skald-active-note-attach',
      attr: { 'aria-label': 'Attach active note to next turn' },
    });
    setIcon(this.attachBtn, 'paperclip');
    setTooltip(this.attachBtn, 'Attach to next turn');
    this.attachBtn.addEventListener('click', () => {
      if (this.current) this.hooks.onAttach(this.current);
    });

    this.subscription = this.app.workspace.on('file-open', (file) => {
      this.update(file ?? null);
    });
    this.update(this.app.workspace.getActiveFile() ?? null);
  }

  /**
   * Refresh the chip based on the supplied active file. Hides the
   * chip when there's no active file or when the active file is a
   * non-markdown asset (we only support attaching .md notes via the
   * @-picker contract).
   */
  private update(file: TFile | null): void {
    const showable = file instanceof TFile && file.extension === 'md';
    if (!showable) {
      this.current = null;
      this.wrapEl.style.display = 'none';
      this.labelEl.setText('');
      return;
    }
    this.current = file;
    this.wrapEl.style.display = '';
    this.labelEl.setText(file.basename);
    setTooltip(this.labelEl, file.path);
  }

  /** Tear down the workspace subscription. Must be called on view
   * close to avoid retained listeners. */
  dispose(): void {
    this.app.workspace.offref(this.subscription);
    this.wrapEl.remove();
  }
}
