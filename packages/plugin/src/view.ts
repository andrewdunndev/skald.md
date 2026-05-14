import { ItemView, WorkspaceLeaf } from 'obsidian';
import type ScribianPlugin from './main';
import { Transport } from './transport';
import type { ServerMessage } from '@scribian/protocol';

export const VIEW_TYPE_SCRIBIAN = 'scribian-chat';

export class ScribianView extends ItemView {
  private plugin: ScribianPlugin;
  private transport: Transport | null = null;
  private statusEl!: HTMLDivElement;
  private messagesEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, plugin: ScribianPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_SCRIBIAN;
  }

  override getDisplayText(): string {
    return 'Scribian';
  }

  override getIcon(): string {
    return 'message-square';
  }

  override async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('scribian-root');

    this.statusEl = root.createDiv({ cls: 'scribian-status' });
    this.setStatus('Disconnected');

    this.messagesEl = root.createDiv({ cls: 'scribian-messages' });

    const inputWrap = root.createDiv({ cls: 'scribian-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'scribian-input',
      attr: { placeholder: 'Type a message…', rows: '2' },
    });
    this.sendBtn = inputWrap.createEl('button', {
      cls: 'scribian-send',
      text: 'Send',
    });

    this.sendBtn.addEventListener('click', () => this.send());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.connect();
  }

  override async onClose(): Promise<void> {
    this.transport?.close();
    this.transport = null;
  }

  private connect(): void {
    const { workerUrl, workerToken } = this.plugin.settings;
    if (!workerUrl || !workerToken) {
      this.setStatus('Not configured. Add Worker URL + token in settings.', 'error');
      return;
    }
    this.setStatus('Connecting…');
    this.transport = new Transport(workerUrl, workerToken, {
      onOpen: () => this.setStatus('Connected', 'connected'),
      onClose: (code, reason) =>
        this.setStatus(`Disconnected (${code}${reason ? `: ${reason}` : ''})`),
      onMessage: (msg) => this.handleMessage(msg),
      onError: (err) => this.setStatus(`Error: ${err}`, 'error'),
    });
    this.transport.connect();
  }

  private send(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.transport?.isOpen()) {
      this.setStatus('Not connected.', 'error');
      return;
    }
    const id = crypto.randomUUID();
    this.appendMessage('You', text);
    this.transport.send({ type: 'echo', id, text });
    this.inputEl.value = '';
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.type === 'echoed') {
      this.appendMessage('Worker', `[echo] ${msg.text}`);
    } else if (msg.type === 'error') {
      this.appendMessage('Error', msg.error);
    } else if (msg.type === 'pong') {
      // Heartbeat ack — no UI surface needed.
    }
  }

  private appendMessage(who: string, text: string): void {
    const row = this.messagesEl.createDiv({ cls: 'scribian-msg' });
    row.createSpan({ cls: 'scribian-msg-who', text: `${who}:` });
    row.createSpan({ text });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private setStatus(text: string, modifier?: 'connected' | 'error'): void {
    this.statusEl.setText(text);
    this.statusEl.removeClass('connected', 'error');
    if (modifier) this.statusEl.addClass(modifier);
  }
}
