import { App, Modal, setIcon } from 'obsidian';

export interface SetupConfirmInput {
  endpoint: string;
  token: string;
  /** Currently-configured Worker URL, for the "this will replace…"
   * warning. Empty if skald was unconfigured. */
  currentEndpoint: string;
}

export interface SetupConfirmHooks {
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * Modal that previews an incoming skald-setup URI before applying
 * it. The setup URI is bearer-grade — anyone with the link gets
 * full access to the named Worker — so silently writing both fields
 * into settings would turn a forwarded link into a phishing vector.
 * This modal makes the user acknowledge: (1) the endpoint they're
 * configuring against, (2) the token they're accepting, (3) the
 * destructive nature if skald was already configured.
 */
export class SetupConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly input: SetupConfirmInput,
    private readonly hooks: SetupConfirmHooks,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('skald-setup-confirm');

    contentEl.createEl('h2', { text: 'Confirm skald setup link' });

    const intro = contentEl.createEl('p', { cls: 'skald-confirm-intro' });
    intro.createSpan({
      text: 'This link will configure skald against the Worker below. ',
    });
    intro.createEl('strong', {
      text: 'Only continue if you generated this link yourself.',
    });
    intro.createSpan({
      text:
        ' Anyone holding this link has the same access to your Worker as you do.',
    });

    if (this.input.currentEndpoint.trim()) {
      const replaceWarn = contentEl.createDiv({
        cls: 'skald-confirm-replace',
      });
      const icon = replaceWarn.createSpan({ cls: 'skald-confirm-icon' });
      setIcon(icon, 'triangle-alert');
      replaceWarn.createSpan({
        text: ` Your current Worker URL (${this.input.currentEndpoint}) and token will be overwritten.`,
      });
    }

    const fields = contentEl.createDiv({ cls: 'skald-confirm-fields' });
    appendField(fields, 'Endpoint', this.input.endpoint);
    appendField(fields, 'Token', maskToken(this.input.token));

    const actions = contentEl.createDiv({ cls: 'skald-confirm-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => {
      this.hooks.onCancel?.();
      this.close();
    });
    const confirm = actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Apply setup',
    });
    confirm.addEventListener('click', () => {
      // Close before invoking so any async work the host runs (e.g.
      // saveSettings, Notices) happens with the modal already gone.
      this.close();
      void this.hooks.onConfirm();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function appendField(
  parent: HTMLElement,
  label: string,
  value: string,
): void {
  const row = parent.createDiv({ cls: 'skald-confirm-field' });
  row.createEl('div', { cls: 'skald-confirm-field-label', text: label });
  row.createEl('code', {
    cls: 'skald-confirm-field-value',
    text: value,
  });
}

/**
 * Mask a bearer token for display. Shows the first 4 + last 4 chars
 * so the user can recognize it without seeing the secret in full.
 * Tokens under 12 chars are masked entirely — too short to safely
 * partial-display.
 */
export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length < 12) return '•'.repeat(Math.max(8, t.length));
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}
