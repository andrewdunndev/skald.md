import {
  Component,
  ItemView,
  MarkdownRenderer,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from 'obsidian';
import type ScribianPlugin from './main';
import { Transport } from './transport';
import { ChatSession } from './chat-session';
import { MODELS } from './settings';
import { READ_ONLY_TOOLS, executeTool } from './tools';
import type { ContentBlock, Message } from '@scribian/protocol';

export const VIEW_TYPE_SCRIBIAN = 'scribian-chat';

const RENDER_THROTTLE_MS = 150;

interface MessageRow {
  el: HTMLDivElement;
  body: HTMLDivElement;
  component: Component;
  finalized: boolean;
}

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
  private rows: MessageRow[] = [];
  private renderTimer: number | null = null;

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
    newChatBtn.addEventListener('click', () => this.resetChat());

    const statusRow = root.createDiv({ cls: 'scribian-status-row' });
    this.statusEl = statusRow.createDiv({ cls: 'scribian-status' });
    const reconnectBtn = statusRow.createEl('button', {
      cls: 'scribian-reconnect',
      text: 'Reconnect',
    });
    reconnectBtn.addEventListener('click', () => this.reconnect());
    this.setStatus('Disconnected');

    this.messagesEl = root.createDiv({ cls: 'scribian-messages' });

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
    this.cancelRenderTimer();
    this.tearDownRows();
    this.transport?.close();
    this.transport = null;
    this.session = null;
  }

  private resetChat(): void {
    this.session?.reset();
    this.tearDownRows();
    this.requestRender();
  }

  private reconnect(): void {
    this.transport?.close();
    this.transport = null;
    this.session = null;
    this.tearDownRows();
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
        onUpdate: () => this.requestRender(),
        onError: (err) => this.setStatus(`Chat error: ${err}`, 'error'),
        onDone: (stopReason, usage) => this.onTurnDone(stopReason, usage),
      },
    );
    this.requestRender();
  }

  private async loadSystemPrompt(): Promise<string | undefined> {
    const folderSetting = this.plugin.settings.harnessFolder.trim();
    if (!folderSetting) return undefined;

    const folderPath =
      folderSetting === '.' || folderSetting === '/'
        ? ''
        : normalizePath(folderSetting);

    const parts: string[] = [];

    const claudeMdPath = folderPath ? `${folderPath}/CLAUDE.md` : 'CLAUDE.md';
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

  private onTurnDone(
    stopReason: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
  ): void {
    this.sendBtn.disabled = false;
    this.stopBtn.style.display = 'none';
    const cache = usage.cache_read_input_tokens
      ? ` (cache hit ${usage.cache_read_input_tokens})`
      : '';
    const stop = stopReason !== 'end_turn' ? ` · ${stopReason}` : '';
    this.setStatus(
      `Connected · last turn: ${usage.input_tokens} in / ${usage.output_tokens} out${cache}${stop}`,
      'connected',
    );
    // Force a final render to lock the finalized message rendering.
    this.flushRender();
  }

  // ─── Render pipeline ────────────────────────────────────────────

  private requestRender(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.flushRender();
    }, RENDER_THROTTLE_MS);
  }

  private cancelRenderTimer(): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private async flushRender(): Promise<void> {
    if (!this.session) return;
    const history = this.session.getMessages();
    const inFlight = this.session.getInFlight();
    const totalCount = history.length + (inFlight ? 1 : 0);

    while (this.rows.length < totalCount) {
      this.appendRow();
    }
    while (this.rows.length > totalCount) {
      this.popRow();
    }

    for (let i = 0; i < totalCount; i++) {
      const isInFlight = i >= history.length;
      const msg: Message = isInFlight
        ? { role: 'assistant', content: inFlight!.blocks }
        : history[i];
      const row = this.rows[i];
      if (row.finalized && !isInFlight) continue;
      await this.renderRow(row, msg);
      if (!isInFlight) row.finalized = true;
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private appendRow(): void {
    const el = this.messagesEl.createDiv({ cls: 'scribian-msg' });
    el.createSpan({ cls: 'scribian-msg-who' });
    const body = el.createDiv({ cls: 'scribian-msg-body' });
    const component = new Component();
    this.addChild(component);
    this.rows.push({ el, body, component, finalized: false });
  }

  private popRow(): void {
    const row = this.rows.pop();
    if (!row) return;
    row.component.unload();
    this.removeChild(row.component);
    row.el.remove();
  }

  private tearDownRows(): void {
    while (this.rows.length > 0) this.popRow();
    this.messagesEl.empty();
  }

  private async renderRow(row: MessageRow, msg: Message): Promise<void> {
    // Refresh role class
    row.el.removeClass('scribian-msg-user', 'scribian-msg-assistant');
    row.el.addClass(`scribian-msg-${msg.role}`);

    const whoEl = row.el.querySelector(
      '.scribian-msg-who',
    ) as HTMLElement | null;
    if (whoEl) whoEl.setText(msg.role === 'user' ? 'You' : 'Claude');

    // Replace the component so previous renders' subscribers are unloaded.
    row.component.unload();
    this.removeChild(row.component);
    row.component = new Component();
    this.addChild(row.component);

    row.body.empty();

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        await this.renderMarkdownInto(row.body, msg.content, row.component);
      }
      return;
    }

    for (const block of msg.content) {
      await this.renderBlock(row.body, block, row.component);
    }
  }

  private async renderMarkdownInto(
    el: HTMLElement,
    md: string,
    component: Component,
  ): Promise<void> {
    // sourcePath empty -> [[Note]] / ![[Note]] resolves from vault root,
    // matching the user's mental model of "Claude references my notes."
    await MarkdownRenderer.render(this.app, md, el, '', component);
  }

  private async renderBlock(
    parent: HTMLElement,
    block: ContentBlock,
    component: Component,
  ): Promise<void> {
    const b = block as Record<string, unknown>;
    const type = b.type as string | undefined;

    if (type === 'text') {
      const text = (b.text as string) ?? '';
      if (!text) return;
      const wrap = parent.createDiv({ cls: 'scribian-text' });
      await this.renderMarkdownInto(wrap, text, component);
      return;
    }

    if (type === 'thinking') {
      const t = parent.createDiv({ cls: 'scribian-thinking' });
      t.createSpan({ cls: 'scribian-thinking-icon', text: '💭' });
      t.createSpan({ text: (b.thinking as string) ?? '' });
      return;
    }

    if (type === 'tool_use') {
      const card = parent.createEl('details', { cls: 'scribian-tool-use' });
      const summary = card.createEl('summary', {
        cls: 'scribian-tool-summary',
      });
      summary.createSpan({
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
      const card = parent.createEl('details', {
        cls: `scribian-tool-result${isError ? ' scribian-tool-result-error' : ''}`,
      });
      const summary = card.createEl('summary', {
        cls: 'scribian-tool-summary',
      });
      summary.createSpan({
        cls: 'scribian-tool-result-label',
        text: isError ? '⚠️ tool error' : '✓ tool result',
      });
      const body = card.createDiv({ cls: 'scribian-tool-result-body' });
      const content = b.content;
      if (typeof content === 'string') {
        await this.renderMarkdownInto(body, content, component);
      } else {
        const pre = body.createEl('pre');
        pre.setText(JSON.stringify(content, null, 2));
      }
      return;
    }

    if (type === 'web_search_tool_result') {
      const card = parent.createEl('details', {
        cls: 'scribian-tool-result scribian-tool-web',
      });
      const summary = card.createEl('summary', {
        cls: 'scribian-tool-summary',
      });
      summary.createSpan({
        cls: 'scribian-tool-result-label',
        text: '🌐 web search results',
      });
      const body = card.createDiv({ cls: 'scribian-tool-result-body' });
      const content = b.content;
      if (Array.isArray(content)) {
        const md = content
          .map((entry: any) => {
            if (entry?.type === 'web_search_result') {
              const title = entry.title ?? entry.url ?? 'result';
              const url = entry.url ?? '';
              const age = entry.page_age ? ` · ${entry.page_age}` : '';
              return `- [${title}](${url})${age}`;
            }
            return `- ${JSON.stringify(entry)}`;
          })
          .join('\n');
        await this.renderMarkdownInto(body, md, component);
      } else {
        const pre = body.createEl('pre');
        pre.setText(JSON.stringify(content, null, 2));
      }
      return;
    }

    if (type === 'server_tool_use') {
      const card = parent.createDiv({ cls: 'scribian-tool-use' });
      card.createSpan({
        cls: 'scribian-tool-name',
        text: `🌐 ${(b.name as string) ?? 'server_tool'}`,
      });
      const input = b.input;
      if (input) {
        const pre = card.createEl('pre', { cls: 'scribian-tool-input' });
        pre.setText(JSON.stringify(input, null, 2));
      }
      return;
    }

    // Unknown block type — render JSON for visibility while we iterate.
    const pre = parent.createEl('pre', { cls: 'scribian-block-unknown' });
    pre.setText(JSON.stringify(b, null, 2));
  }

  private setStatus(text: string, modifier?: 'connected' | 'error'): void {
    this.statusEl.setText(text);
    this.statusEl.removeClass('connected', 'error');
    if (modifier) this.statusEl.addClass(modifier);
  }
}
