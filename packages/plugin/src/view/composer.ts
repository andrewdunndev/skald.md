import { App, TFile, setIcon, setTooltip } from 'obsidian';
import {
  attachmentsFromClipboard,
  attachmentsFromFiles,
  clipboardHasImage,
  humanByteCount,
  type ImageAttachment,
} from '../image-attach';
import { NotePicker } from './note-picker';

export interface ComposerHooks {
  /** User pressed Enter or clicked Send with non-empty input. */
  onSend: () => void;
  /** User clicked Stop on an in-flight turn. */
  onStop: () => void;
}

/**
 * Input row at the bottom of the chat pane. Owns the textarea, the
 * send/stop/camera buttons, the @-picker, the picked-attachment chip
 * row, and the paste/file event handlers. ScribianView reads the
 * composer's current text + attachments when sending; the composer
 * doesn't know about the transport or chat session.
 */
export class Composer {
  private readonly inputEl: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly chipEl: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  private readonly notePicker: NotePicker;
  private pickedFiles: TFile[] = [];
  private pickedImages: ImageAttachment[] = [];

  constructor(
    root: HTMLElement,
    private readonly app: App,
    private readonly hooks: ComposerHooks,
  ) {
    // Chip slot — only renders when notes are explicitly attached via @.
    // No auto-attachment of the active vault note (avoids visual noise +
    // surprise context injection).
    this.chipEl = root.createDiv({ cls: 'scribian-chip-row' });
    this.renderChip();

    const inputWrap = root.createDiv({ cls: 'scribian-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'scribian-input',
      attr: {
        placeholder: 'Ask Claude…',
        rows: '2',
        // Mobile signals: capitalize starts of sentences, autocorrect
        // on, show "Send" instead of "Return" on the iOS keyboard.
        // The iOS mic icon on the keyboard is the dictation entry —
        // these attributes make it feel native rather than fighting
        // the OS.
        autocapitalize: 'sentences',
        autocorrect: 'on',
        spellcheck: 'true',
        enterkeyhint: 'send',
      },
    });
    const buttonRow = inputWrap.createDiv({ cls: 'scribian-button-row' });

    // Phase 7 (vision): file/camera picker. Available on every
    // platform; on iOS the `capture="environment"` attribute opens
    // the camera UI directly. On desktop the user gets the standard
    // file picker (image-only filter).
    const cameraBtn = buttonRow.createEl('button', {
      cls: 'clickable-icon scribian-icon-btn scribian-camera',
      attr: { 'aria-label': 'Attach image' },
    });
    setIcon(cameraBtn, 'camera');
    setTooltip(cameraBtn, 'Attach image (photo / file)');
    this.fileInput = buttonRow.createEl('input', {
      cls: 'scribian-file-input',
      attr: {
        type: 'file',
        accept: 'image/jpeg,image/png,image/gif,image/webp',
        multiple: 'true',
        capture: 'environment',
      },
    });
    this.fileInput.style.display = 'none';
    cameraBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files) void this.handleImageFiles(this.fileInput.files);
      // Reset so picking the same file twice fires the change event.
      this.fileInput.value = '';
    });

    this.sendBtn = buttonRow.createEl('button', {
      cls: 'clickable-icon scribian-icon-btn scribian-send',
      attr: { 'aria-label': 'Send' },
    });
    setIcon(this.sendBtn, 'send-horizontal');
    setTooltip(this.sendBtn, 'Send (Enter)');
    this.stopBtn = buttonRow.createEl('button', {
      cls: 'clickable-icon scribian-icon-btn scribian-stop',
      attr: { 'aria-label': 'Stop' },
    });
    setIcon(this.stopBtn, 'square');
    setTooltip(this.stopBtn, 'Stop generating');
    this.stopBtn.style.display = 'none';

    this.sendBtn.addEventListener('click', () => this.hooks.onSend());
    this.stopBtn.addEventListener('click', () => this.hooks.onStop());

    // Vision (phase 7): pasted images become attached image content
    // blocks on the next send. Caught here on the input so plain
    // markdown / text paste flows through normally to the textarea.
    this.inputEl.addEventListener('paste', (e) => {
      if (!clipboardHasImage(e)) return;
      e.preventDefault();
      void this.handleImagePaste(e);
    });

    this.notePicker = new NotePicker(this.app, this.inputEl, this.chipEl, {
      onPick: (file) => {
        if (!this.pickedFiles.includes(file)) this.pickedFiles.push(file);
        this.renderChip();
      },
    });

    const recomputePicker = () => this.notePicker.updateForCursor();
    this.inputEl.addEventListener('input', recomputePicker);
    this.inputEl.addEventListener('click', recomputePicker);
    this.inputEl.addEventListener('keyup', (e) => {
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'Home' ||
        e.key === 'End'
      ) {
        recomputePicker();
      }
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (this.notePicker.isOpen()) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.notePicker.moveSelection(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.notePicker.moveSelection(-1);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.notePicker.acceptSelection();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.notePicker.close();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.hooks.onSend();
      }
    });
  }

  text(): string {
    return this.inputEl.value;
  }

  attachedFiles(): TFile[] {
    return this.pickedFiles;
  }

  attachedImages(): ImageAttachment[] {
    return this.pickedImages;
  }

  clearInput(): void {
    this.inputEl.value = '';
  }

  clearImages(): void {
    this.pickedImages = [];
    this.renderChip();
  }

  /**
   * Toggle send/stop button state. When busy, send becomes disabled
   * and stop becomes visible; on done, the reverse.
   */
  setBusy(busy: boolean): void {
    this.sendBtn.disabled = busy;
    this.stopBtn.style.display = busy ? '' : 'none';
  }

  /**
   * Drop text into the chat input from outside the composer (e.g. a
   * slash command modal expanding a template). Focuses the input
   * and moves the cursor to the end so the user can review +
   * augment before sending.
   */
  fillText(text: string): void {
    this.inputEl.value = text;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    // Trigger input event so the @-picker (and any future input
    // listeners) recompute for the new text.
    this.inputEl.dispatchEvent(new Event('input'));
  }

  /**
   * Programmatically open the image picker. On iOS with
   * `capture="environment"` set, this jumps straight to the camera;
   * desktop browsers fall back to the file dialog. Used by the
   * empty-state "Identify + file" chip so one tap goes from intent
   * to "image staged + prompt prefilled."
   */
  pickImage(): void {
    this.fileInput.click();
  }

  /**
   * Attach a vault file to the next turn from outside the composer
   * (e.g. the active-note indicator's paperclip button). Idempotent —
   * attaching the same file twice is a no-op.
   */
  attachFile(file: TFile): void {
    if (this.pickedFiles.includes(file)) return;
    this.pickedFiles.push(file);
    this.renderChip();
  }

  /**
   * Catch image clipboard data on the input element. Convert to
   * base64 attachments + render chips; the actual image content
   * blocks are built by the caller on submit.
   */
  private async handleImagePaste(e: ClipboardEvent): Promise<void> {
    const next = await attachmentsFromClipboard(e);
    if (next.length === 0) return;
    this.pickedImages.push(...next);
    this.renderChip();
  }

  /**
   * Catch images from the camera / file picker (phase 7). The
   * `<input type=file capture=environment>` triggers the iOS camera
   * directly; desktop browsers fall back to the file dialog.
   */
  private async handleImageFiles(files: FileList): Promise<void> {
    const next = await attachmentsFromFiles(files);
    if (next.length === 0) return;
    this.pickedImages.push(...next);
    this.renderChip();
  }

  private renderChip(): void {
    this.chipEl.empty();

    for (const f of this.pickedFiles) {
      const chip = this.chipEl.createDiv({ cls: 'scribian-chip' });
      const label = chip.createSpan({
        cls: 'scribian-chip-label',
        text: f.basename,
      });
      label.addEventListener('click', () => {
        this.app.workspace.openLinkText(f.path, '', false);
      });
      const dismiss = chip.createEl('button', {
        cls: 'clickable-icon scribian-chip-dismiss',
        attr: { 'aria-label': 'Remove attachment' },
      });
      setIcon(dismiss, 'x');
      dismiss.addEventListener('click', () => {
        this.pickedFiles = this.pickedFiles.filter((x) => x !== f);
        this.renderChip();
      });
    }

    for (const img of this.pickedImages) {
      const chip = this.chipEl.createDiv({
        cls: 'scribian-chip scribian-chip-image',
      });
      const icon = chip.createSpan({ cls: 'scribian-chip-icon' });
      setIcon(icon, 'image');
      chip.createSpan({
        cls: 'scribian-chip-label',
        text: `${img.label} · ${humanByteCount(img.byteLength)}`,
      });
      const dismiss = chip.createEl('button', {
        cls: 'clickable-icon scribian-chip-dismiss',
        attr: { 'aria-label': 'Remove image' },
      });
      setIcon(dismiss, 'x');
      dismiss.addEventListener('click', () => {
        this.pickedImages = this.pickedImages.filter((x) => x.id !== img.id);
        this.renderChip();
      });
    }

    // Hide the slot entirely when empty — no "type @ to attach" noise.
    this.chipEl.style.display =
      this.chipEl.childElementCount === 0 ? 'none' : '';
  }
}
