import { ItemView, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';
import type ScribianPlugin from './main';
import { Transport } from './transport';
import { ChatSession } from './chat-session';
import { MODELS } from './settings';
import { READ_ONLY_TOOLS, executeTool } from './tools';
import type { ContentBlock, Message } from '@scribian/protocol';

export const VIEW_TYPE_SCRIBIAN = 'scribian-chat';

export class ScribianView extends ItemView {
  private plugin: ScribianPlugin;
  private transport: Transport | null = null;
  private session: ChatSession | null = null;
  private modelSelect!: HTMLSelectElement;
  private statusEl!: HTMLDivElement;
  private messagesEl!: HTMLDivElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;

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

    // Header — model picker + new-chat
    const header = root.createDiv({ cls: 'scribian-header' });
    this.modelSelect = header.createEl('select', { cls: 'scribian-model' });
    for (const m of MODELS) {
      const opt = this.modelSelect.createEl('option', {
        text: m.label,
        value: m.id,
      });
      if (m.id === this.plugin.settings.defaultModel) opt.selected = true;
    }
    this.modelSelect.addEventListener('change', async () => {
      this.plugin.settings.defaultModel = this.modelSelect.value;
      await this.plugin.saveSettings();
    });

    const newChatBtn = header.createEl('button', {
      cls: 'scribian-new-chat',
      text: 'New chat',
    });
    newChatBtn.addEventListener('click', () => this.session?.reset());

    // Status row — status + reconnect
    const statusRow = root.createDiv({ cls: 'scribian-status-row' });
    this.statusEl = statusRow.createDiv({ cls: 'scribian-status' });
    const reconnectBtn = statusRow.createEl('button', {
      cls: 'scribian-reconnect',
      text: 'Reconnect',
    });
    reconnectBtn.addEventListener('click', () => this.reconnect());
    this.setStatus('Disconnected');

    // Messages
    this.messagesEl = root.createDiv({ cls: 'scribian-messages' });

    // Input + send/stop
    const inputWrap = root.createDiv({ cls: 'scribian-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'scribian-input',
      attr: { placeholder: 'Ask Claude…', rows: '2' },
    });
    const buttonRow = inputWrap.createDiv({ cls: 'scribian-button-row' });
    this.sendBtn = buttonRow.createEl('button', {
      cls: 'scribian-send',
      text: 'Send',
    });
    this.stopBtn = buttonRow.createEl('button', {
      cls: 'scribian-stop',
      text: 'Stop',
    });
    this.stopBtn.style.display = 'none';

    this.sendBtn.addEventListener('click', () => this.send());
    this.stopBtn.addEventListener('click', () => this.session?.cancel());
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
    this.session = null;
  }

  private reconnect(): void {
    this.transport?.close();
    this.transport = null;
    this.session = null;
    this.connect();
  }

  private connect(): void {
    const { workerUrl, workerToken } = this.plugin.settings;
    if (!workerUrl || !workerToken) {
      this.setStatus(
        'Not configured. Add Worker URL + token in settings.',
        'error',
      );
      return;
    }
    this.setStatus('Connecting…');
    this.transport = new Transport(workerUrl, workerToken, {
      onOpen: () => this.setStatus('Connected', 'connected'),
      onClose: (code, reason) =>
        this.setStatus(`Disconnected (${code}${reason ? `: ${reason}` : ''})`),
      onMessage: (msg) => this.session?.handleServer(msg),
      onError: (err) => this.setStatus(`Error: ${err}`, 'error'),
    });
    this.transport.connect();

    this.session = new ChatSession(
      this.transport,
      () => this.modelSelect.value,
      () => this.loadSystemPrompt(),
      () => this.plugin.settings.anthropicApiKey || undefined,
      READ_ONLY_TOOLS,
      (name, input) => executeTool(this.app, name, input),
      {
        onUpdate: () => this.renderMessages(),
        onError: (err) => this.setStatus(`Chat error: ${err}`, 'error'),
        onDone: (stopReason, usage) => this.onTurnDone(stopReason, usage),
      },
    );
    this.renderMessages();
  }

  private async loadSystemPrompt(): Promise<string | undefined> {
    const folderSetting = this.plugin.settings.harnessFolder.trim();
    // Empty setting disables harness loading entirely.
    if (!folderSetting) return undefined;

    // `.` or `/` means "use vault root".
    const folderPath =
      folderSetting === '.' || folderSetting === '/'
        ? ''
        : normalizePath(folderSetting);

    const parts: string[] = [];

    const claudeMdPath = folderPath
      ? `${folderPath}/CLAUDE.md`
      : 'CLAUDE.md';
    const claudeMd = this.app.vault.getAbstractFileByPath(claudeMdPath);
    if (claudeMd instanceof TFile) {
      try {
        parts.push(await this.app.vault.read(claudeMd));
      } catch {
        // ignore unreadable file
      }
    }

    const skillsPath = folderPath ? `${folderPath}/skills` : 'skills';
    const skillsFolder = this.app.vault.getAbstractFileByPath(skillsPath);
    if (skillsFolder instanceof TFolder) {
      const skills = await this.collectSkills(skillsFolder);
      if (skills.length > 0) {
        parts.push('## Skills\n\n' + skills.join('\n\n---\n\n'));
      }
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
  }

  private async collectSkills(folder: TFolder): Promise<string[]> {
    const out: string[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        try {
          const content = await this.app.vault.read(child);
          out.push(`### ${child.basename}\n\n${content}`);
        } catch {
          // skip unreadable
        }
      } else if (child instanceof TFolder) {
        const nested = await this.collectSkills(child);
        out.push(...nested);
      }
    }
    return out;
  }

  private send(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.transport?.isOpen() || !this.session) {
      this.setStatus('Not connected.', 'error');
      return;
    }
    this.inputEl.value = '';
    this.sendBtn.disabled = true;
    this.stopBtn.style.display = '';
    void this.session.sendUserText(text);
  }

  private onTurnDone(stopReason: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): void {
    this.sendBtn.disabled = false;
    this.stopBtn.style.display = 'none';
    const cache = usage.cache_read_input_tokens
      ? ` (cache hit ${usage.cache_read_input_tokens})`
      : '';
    this.setStatus(
      `Connected · last turn: ${usage.input_tokens} in / ${usage.output_tokens} out${cache}${stopReason !== 'end_turn' ? ` · ${stopReason}` : ''}`,
      'connected',
    );
  }

  private renderMessages(): void {
    if (!this.session) return;
    this.messagesEl.empty();

    for (const m of this.session.getMessages()) {
      this.renderMessage(m);
    }
    const inFlight = this.session.getInFlight();
    if (inFlight) {
      this.renderMessage({
        role: 'assistant',
        content: inFlight.blocks,
      });
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderMessage(m: Message): void {
    const row = this.messagesEl.createDiv({
      cls: `scribian-msg scribian-msg-${m.role}`,
    });
    row.createSpan({
      cls: 'scribian-msg-who',
      text: m.role === 'user' ? 'You' : 'Claude',
    });

    const body = row.createDiv({ cls: 'scribian-msg-body' });
    if (typeof m.content === 'string') {
      body.createSpan({ text: m.content });
      return;
    }
    for (const block of m.content) {
      this.renderBlock(body, block);
    }
  }

  private renderBlock(parent: HTMLElement, block: ContentBlock): void {
    const b = block as Record<string, unknown>;
    const type = b.type as string;
    if (type === 'text') {
      parent.createSpan({ text: (b.text as string) ?? '' });
      return;
    }
    if (type === 'thinking') {
      const t = parent.createDiv({ cls: 'scribian-thinking' });
      t.setText(`💭 ${(b.thinking as string) ?? ''}`);
      return;
    }
    if (type === 'tool_use') {
      const card = parent.createDiv({ cls: 'scribian-tool-use' });
      card.createSpan({
        cls: 'scribian-tool-name',
        text: `🔧 ${(b.name as string) ?? 'tool'}`,
      });
      const input = b.input ?? b.partial_json;
      if (input) {
        const pre = card.createEl('pre', { cls: 'scribian-tool-input' });
        pre.setText(
          typeof input === 'string' ? input : JSON.stringify(input, null, 2),
        );
      }
      return;
    }
    if (type === 'tool_result') {
      const isError = b.is_error === true;
      const card = parent.createDiv({
        cls: `scribian-tool-result${isError ? ' scribian-tool-result-error' : ''}`,
      });
      card.createSpan({
        cls: 'scribian-tool-result-label',
        text: isError ? '⚠️ tool error' : '✓ tool result',
      });
      const content =
        typeof b.content === 'string'
          ? b.content
          : JSON.stringify(b.content, null, 2);
      const pre = card.createEl('pre', { cls: 'scribian-tool-result-body' });
      pre.setText(content);
      return;
    }
    // Unknown block type — render as JSON for visibility while we iterate.
    const pre = parent.createEl('pre', { cls: 'scribian-block-unknown' });
    pre.setText(JSON.stringify(b, null, 2));
  }

  private setStatus(text: string, modifier?: 'connected' | 'error'): void {
    this.statusEl.setText(text);
    this.statusEl.removeClass('connected', 'error');
    if (modifier) this.statusEl.addClass(modifier);
  }
}
