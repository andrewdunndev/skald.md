import {
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  prepareFuzzySearch,
  setIcon,
  setTooltip,
} from 'obsidian';
import type ScribianPlugin from './main';
import { Transport } from './transport';
import { ChatSession } from './chat-session';
import { MODELS } from './settings';
import { ALL_TOOLS, executeTool } from './tools';
import type { WriteProposal } from './tools';
import { saveConversation } from './conversation-store';
import type { ContentBlock, Message } from '@scribian/protocol';

export const VIEW_TYPE_SCRIBIAN = 'scribian-chat';

const RENDER_THROTTLE_MS = 150;

/**
 * Turn a tool_use into a single-line human-readable summary for the
 * collapsed card. Raw JSON args still appear when the user expands it.
 */
function describeToolUse(name: string, input: unknown): string {
  const i = (input as Record<string, any>) ?? {};
  switch (name) {
    case 'read_note':
      return `📖 Reading ${i.path ?? '?'}`;
    case 'list_notes': {
      const where = i.folder ? ` in \`${i.folder}\`` : '';
      const limit = i.limit ? ` (limit ${i.limit})` : '';
      return `📋 Listing notes${where}${limit}`;
    }
    case 'search_vault':
      return `🔍 Searching vault for "${i.query ?? '?'}"`;
    case 'current_note':
      return `📍 Reading the current note`;
    case 'metadata':
      return `ℹ️ Metadata for ${i.path ?? '?'}`;
    case 'web_search':
      return `🌐 Web search: "${i.query ?? '?'}"`;
    case 'web_fetch':
      return `🌐 Fetching ${i.url ?? '?'}`;
    case 'write_note':
      return `✏️ Write ${i.path ?? '?'}`;
    case 'edit_note':
      return `✏️ Edit ${i.path ?? '?'}`;
    case 'append_to_note':
      return `➕ Append to ${i.path ?? '?'}`;
    default:
      return `🔧 ${name}`;
  }
}

/**
 * Turn a tool_result into a single-line summary when content is a string.
 * Falls back to "✓ tool result" if we can't read the shape.
 */
function describeToolResult(content: unknown, isError: boolean): string {
  if (isError) return '⚠️ tool error';
  if (typeof content === 'string') {
    const firstLine = content.split('\n')[0].trim();
    if (firstLine.length === 0) return '✓ result (empty)';
    if (firstLine.length > 80) return `✓ ${firstLine.slice(0, 77)}…`;
    // If the rest of the content is multi-line, hint that more is hidden
    const more = content.includes('\n') ? ' …' : '';
    return `✓ ${firstLine}${more}`;
  }
  return '✓ tool result';
}

// CSS.escape isn't always available; fall back to a regex strip for safety.
function cssEscape(s: string): string {
  if (typeof (window as any).CSS?.escape === 'function') {
    return (window as any).CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// LCS-based line diff. Produces a unified-style change list.
interface DiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
}

function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.unshift({ type: 'same', text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: 'add', text: b[j - 1] });
      j -= 1;
    } else {
      out.unshift({ type: 'remove', text: a[i - 1] });
      i -= 1;
    }
  }
  return out;
}

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
  private chipEl!: HTMLDivElement;
  private pickedFiles: TFile[] = [];
  private pickerEl: HTMLDivElement | null = null;
  private pickerAnchor: number = -1;
  private pickerSelectedIdx: number = 0;
  private pickerResults: TFile[] = [];
  private pendingApprovals: Map<
    string,
    { proposal: WriteProposal; resolve: (approved: boolean) => void }
  > = new Map();

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
      cls: 'clickable-icon scribian-icon-btn',
      attr: { 'aria-label': 'New chat' },
    });
    setIcon(newChatBtn, 'square-pen');
    setTooltip(newChatBtn, 'New chat');
    newChatBtn.addEventListener('click', () => this.resetChat());

    const statusRow = root.createDiv({ cls: 'scribian-status-row' });
    this.statusEl = statusRow.createDiv({ cls: 'scribian-status' });
    const reconnectBtn = statusRow.createEl('button', {
      cls: 'clickable-icon scribian-icon-btn',
      attr: { 'aria-label': 'Reconnect' },
    });
    setIcon(reconnectBtn, 'rotate-cw');
    setTooltip(reconnectBtn, 'Reconnect');
    reconnectBtn.addEventListener('click', () => this.reconnect());
    this.setStatus('Disconnected');

    this.messagesEl = root.createDiv({ cls: 'scribian-messages' });

    // Chip slot — only renders when notes are explicitly attached via @.
    // No auto-attachment of the active vault note (avoids visual noise +
    // surprise context injection).
    this.chipEl = root.createDiv({ cls: 'scribian-chip-row' });
    this.renderChip();

    const inputWrap = root.createDiv({ cls: 'scribian-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'scribian-input',
      attr: { placeholder: 'Ask Claude…', rows: '2' },
    });
    const buttonRow = inputWrap.createDiv({ cls: 'scribian-button-row' });
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

    this.sendBtn.addEventListener('click', () => this.send());
    this.stopBtn.addEventListener('click', () => this.session?.cancel());
    this.inputEl.addEventListener('input', () => this.updatePickerForCursor());
    this.inputEl.addEventListener('click', () => this.updatePickerForCursor());
    this.inputEl.addEventListener('keyup', (e) => {
      // arrow/home/end land here too; trigger picker recompute
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'Home' ||
        e.key === 'End'
      ) {
        this.updatePickerForCursor();
      }
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (this.pickerEl && this.pickerResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.pickerSelectedIdx =
            (this.pickerSelectedIdx + 1) % this.pickerResults.length;
          this.renderPicker();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.pickerSelectedIdx =
            (this.pickerSelectedIdx - 1 + this.pickerResults.length) %
            this.pickerResults.length;
          this.renderPicker();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.pickResult(this.pickerSelectedIdx);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closePicker();
          return;
        }
      }
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
      ALL_TOOLS,
      (name, input, toolUseId) =>
        executeTool(
          this.app,
          name,
          input,
          toolUseId,
          (proposal) => this.requestApproval(proposal),
        ),
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

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.transport?.isOpen() || !this.session) {
      this.setStatus('Not connected.', 'error');
      return;
    }
    this.inputEl.value = '';
    this.sendBtn.disabled = true;
    this.stopBtn.style.display = '';
    const augmented = await this.augmentUserText(text);
    void this.session.sendUserText(augmented);
  }

  /**
   * Wrap the user's text in a <context> block listing any explicitly
   * @-attached notes. Active vault file is NOT included automatically —
   * users opt in by @-attaching what they want Claude to see.
   */
  private async augmentUserText(text: string): Promise<string> {
    if (this.pickedFiles.length === 0) return text;

    const blocks: string[] = ['<context>'];
    for (const file of this.pickedFiles) {
      try {
        const content = await this.app.vault.read(file);
        blocks.push(`  <file path="${file.path}">`);
        blocks.push(content);
        blocks.push('  </file>');
      } catch {
        // skip unreadable
      }
    }
    blocks.push('</context>', '', text);
    return blocks.join('\n');
  }

  // ─── Attached-note chips ─────────────────────────────────────────

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

    // Hide the slot entirely when empty — no "type @ to attach" noise.
    this.chipEl.style.display =
      this.chipEl.childElementCount === 0 ? 'none' : '';
  }

  // ─── @ picker ────────────────────────────────────────────────────

  private updatePickerForCursor(): void {
    const text = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? text.length;
    const before = text.slice(0, cursor);
    const atMatch = before.match(/(^|\s)@([^\s@]*)$/);
    if (!atMatch) {
      this.closePicker();
      return;
    }
    const query = atMatch[2];
    const atIndex = cursor - query.length - 1;
    this.openPicker(atIndex, query);
  }

  private openPicker(atIndex: number, query: string): void {
    this.pickerAnchor = atIndex;
    this.pickerResults = this.searchVault(query);
    this.pickerSelectedIdx = 0;
    if (!this.pickerEl) {
      this.pickerEl = this.chipEl.insertAdjacentElement(
        'afterend',
        createDiv({ cls: 'scribian-picker' }),
      ) as HTMLDivElement;
    }
    this.renderPicker();
  }

  private closePicker(): void {
    if (!this.pickerEl) return;
    this.pickerEl.remove();
    this.pickerEl = null;
    this.pickerResults = [];
    this.pickerAnchor = -1;
  }

  private renderPicker(): void {
    if (!this.pickerEl) return;
    this.pickerEl.empty();
    if (this.pickerResults.length === 0) {
      const empty = this.pickerEl.createDiv({ cls: 'scribian-picker-empty' });
      empty.setText('No matching notes');
      return;
    }
    this.pickerResults.forEach((file, idx) => {
      const row = this.pickerEl!.createDiv({
        cls: `scribian-picker-row${idx === this.pickerSelectedIdx ? ' is-selected' : ''}`,
      });
      row.createSpan({
        cls: 'scribian-picker-name',
        text: file.basename,
      });
      const folder = file.parent?.path;
      if (folder && folder !== '/') {
        row.createSpan({
          cls: 'scribian-picker-folder',
          text: folder,
        });
      }
      row.addEventListener('click', (e) => {
        e.preventDefault();
        this.pickResult(idx);
      });
      // Avoid stealing focus from the textarea on mousedown
      row.addEventListener('mousedown', (e) => e.preventDefault());
    });
  }

  private pickResult(idx: number): void {
    const file = this.pickerResults[idx];
    if (!file) return;
    // Replace "@query" text in the input with empty (or a space)
    const text = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? text.length;
    const replaced =
      text.slice(0, this.pickerAnchor) + text.slice(cursor);
    this.inputEl.value = replaced;
    this.inputEl.setSelectionRange(this.pickerAnchor, this.pickerAnchor);
    this.inputEl.focus();

    // Add to attachments unless already present
    if (!this.pickedFiles.includes(file)) {
      this.pickedFiles.push(file);
    }
    this.closePicker();
    this.renderChip();
  }

  private searchVault(query: string): TFile[] {
    const all = this.app.vault.getMarkdownFiles();
    if (!query) {
      // Empty query: most-recently-modified first
      return [...all]
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 8);
    }
    const fuzzy = prepareFuzzySearch(query);
    type Scored = { file: TFile; score: number };
    const scored: Scored[] = [];
    for (const f of all) {
      const result =
        fuzzy(f.basename) ?? fuzzy(f.path);
      if (result) {
        scored.push({ file: f, score: result.score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.file);
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
    // Persist the conversation to the configured chats folder. Errors are
    // swallowed inside saveConversation; users see the file in their vault.
    void this.persistConversation();
  }

  private async persistConversation(): Promise<void> {
    if (!this.session) return;
    const folder = this.plugin.settings.chatsFolder.trim();
    if (!folder) return;
    await saveConversation(
      this.app,
      folder,
      {
        id: this.session.conversationId,
        model: this.modelSelect.value,
        created: this.session.conversationCreated,
        updated: new Date().toISOString(),
      },
      this.session.getMessages(),
    );
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
      // Toggle the streaming class so CSS can animate the in-flight row.
      row.el.toggleClass('scribian-msg-streaming', isInFlight);
      if (row.finalized && !isInFlight) continue;
      await this.renderRow(row, msg, isInFlight);
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

  private async renderRow(
    row: MessageRow,
    msg: Message,
    isInFlight: boolean,
  ): Promise<void> {
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

    // Per-message action row at the bottom of every finalized Claude turn.
    // Hover-based actions don't work on mobile, so these are always visible.
    if (msg.role === 'assistant' && !isInFlight) {
      this.renderMessageActions(row.el, msg);
    }
  }

  private renderMessageActions(row: HTMLElement, msg: Message): void {
    const actions = row.createDiv({ cls: 'scribian-msg-actions' });
    const text = this.messageText(msg);

    const copyBtn = actions.createEl('button', {
      cls: 'clickable-icon scribian-msg-action',
      attr: { 'aria-label': 'Copy message' },
    });
    setIcon(copyBtn, 'copy');
    setTooltip(copyBtn, 'Copy');
    copyBtn.addEventListener('click', () => this.copyMessage(text, copyBtn));

    const saveBtn = actions.createEl('button', {
      cls: 'clickable-icon scribian-msg-action',
      attr: { 'aria-label': 'Save as note' },
    });
    setIcon(saveBtn, 'file-plus');
    setTooltip(saveBtn, 'Save as new note');
    saveBtn.addEventListener('click', () => this.saveAsNote(text));

    const appendBtn = actions.createEl('button', {
      cls: 'clickable-icon scribian-msg-action',
      attr: { 'aria-label': 'Append to current note' },
    });
    setIcon(appendBtn, 'file-down');
    setTooltip(appendBtn, 'Append to current note');
    appendBtn.addEventListener('click', () => this.appendToCurrent(text));
  }

  /**
   * Concatenate the message's textual content for copy / save operations.
   * Skips thinking blocks (internal), tool calls (UI noise), and any
   * non-textual blocks. Returns the rendered-source markdown so the
   * saved note matches what's shown.
   */
  private messageText(msg: Message): string {
    if (typeof msg.content === 'string') return msg.content;
    const parts: string[] = [];
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      const t = b.type as string | undefined;
      if (t === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    return parts.join('\n\n');
  }

  private async copyMessage(text: string, btn: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      // Brief visual ack — swap the icon to a check for ~1s.
      setIcon(btn, 'check');
      setTimeout(() => setIcon(btn, 'copy'), 1200);
    } catch {
      new Notice('Copy failed');
    }
  }

  private async saveAsNote(text: string): Promise<void> {
    if (!text.trim()) {
      new Notice('Nothing to save');
      return;
    }
    const folder = this.plugin.settings.savedNotesFolder.trim() || 'Scribian/Saved';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = normalizePath(`${folder}/${ts}.md`);
    try {
      // Make sure folder exists
      const folderItem = this.app.vault.getAbstractFileByPath(folder);
      if (!folderItem) {
        await this.app.vault.createFolder(folder);
      }
      const created = await this.app.vault.create(path, text);
      new Notice(`Saved to ${path}`);
      this.app.workspace.openLinkText(created.path, '', false);
    } catch (err) {
      new Notice(
        `Save failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private async appendToCurrent(text: string): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('No active note to append to');
      return;
    }
    try {
      const existing = await this.app.vault.read(file);
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      await this.app.vault.modify(file, existing + sep + text);
      new Notice(`Appended to ${file.basename}`);
    } catch (err) {
      new Notice(
        `Append failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private async renderMarkdownInto(
    el: HTMLElement,
    md: string,
    component: Component,
  ): Promise<void> {
    // sourcePath empty -> [[Note]] / ![[Note]] resolves from vault root,
    // matching the user's mental model of "Claude references my notes."
    // The markdown-rendered class scopes Obsidian's reading-view CSS so
    // tables get borders, callouts get backgrounds, etc., identical to
    // how notes look elsewhere in the app.
    el.addClass('markdown-rendered');
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
      const id = b.id as string | undefined;
      const name = (b.name as string) ?? 'tool';
      const input = b.input ?? b.partial_json;
      // Single-line, human-readable summary. JSON args are intentionally
      // hidden — non-technical users don't need to see them, and dev folks
      // can drop to the console.
      const row = parent.createDiv({ cls: 'scribian-tool-call' });
      row.createSpan({
        cls: 'scribian-tool-name',
        text: describeToolUse(name, input),
      });
      if (id && this.pendingApprovals.has(id)) {
        const pending = this.pendingApprovals.get(id)!;
        this.renderDiffCard(parent, pending.proposal, pending.resolve);
      }
      return;
    }

    if (type === 'tool_result') {
      const isError = b.is_error === true;
      const content = b.content;
      const hasStringContent = typeof content === 'string' && content.length > 0;
      // Tool results render as a collapsible only when there's content
      // worth expanding. Empty / non-string results stay as a single line.
      if (!hasStringContent) {
        const row = parent.createDiv({
          cls: `scribian-tool-result-row${isError ? ' scribian-tool-result-error' : ''}`,
        });
        row.createSpan({
          cls: 'scribian-tool-result-label',
          text: describeToolResult(content, isError),
        });
        return;
      }
      const card = parent.createEl('details', {
        cls: `scribian-tool-result${isError ? ' scribian-tool-result-error' : ''}`,
      });
      const summary = card.createEl('summary', {
        cls: 'scribian-tool-summary',
      });
      summary.createSpan({
        cls: 'scribian-tool-result-label',
        text: describeToolResult(content, isError),
      });
      const body = card.createDiv({ cls: 'scribian-tool-result-body' });
      await this.renderMarkdownInto(body, content as string, component);
      return;
    }

    if (type === 'web_search_tool_result') {
      const card = parent.createEl('details', {
        cls: 'scribian-tool-result scribian-tool-web',
      });
      const summary = card.createEl('summary', {
        cls: 'scribian-tool-summary',
      });
      const content = b.content;
      const hitCount = Array.isArray(content) ? content.length : 0;
      summary.createSpan({
        cls: 'scribian-tool-result-label',
        text: `🌐 ${hitCount} web result${hitCount === 1 ? '' : 's'}`,
      });
      const body = card.createDiv({ cls: 'scribian-tool-result-body' });
      if (Array.isArray(content)) {
        const md = content
          .map((entry: any) => {
            if (entry?.type === 'web_search_result') {
              const title = entry.title ?? entry.url ?? 'result';
              const url = entry.url ?? '';
              const age = entry.page_age ? ` · ${entry.page_age}` : '';
              return `- [${title}](${url})${age}`;
            }
            return `- ${entry?.title ?? entry?.url ?? '(unknown result)'}`;
          })
          .join('\n');
        await this.renderMarkdownInto(body, md, component);
      } else {
        body.createSpan({ text: '(no results)' });
      }
      return;
    }

    if (type === 'web_fetch_tool_result') {
      const content = b.content as Record<string, any> | undefined;
      const card = parent.createEl('details', {
        cls: 'scribian-tool-result scribian-tool-web',
      });
      const summary = card.createEl('summary', {
        cls: 'scribian-tool-summary',
      });
      const url = content?.url as string | undefined;
      summary.createSpan({
        cls: 'scribian-tool-result-label',
        text: url ? `🌐 Fetched ${url}` : '🌐 Fetched',
      });
      const body = card.createDiv({ cls: 'scribian-tool-result-body' });
      // web_fetch returns content as either a document object with extracted
      // markdown, or an array of content blocks. Try to surface the text;
      // never dump JSON.
      const inner = content?.content as unknown;
      if (typeof inner === 'string') {
        await this.renderMarkdownInto(body, inner, component);
      } else if (Array.isArray(inner)) {
        for (const entry of inner) {
          if (entry?.type === 'text' && typeof entry.text === 'string') {
            await this.renderMarkdownInto(body, entry.text, component);
          }
        }
      } else if (inner && typeof inner === 'object') {
        const doc = inner as Record<string, any>;
        const text = (doc.text as string) ?? (doc.source?.data as string);
        if (text) {
          await this.renderMarkdownInto(body, text, component);
        } else {
          body.createSpan({ text: '(fetched, but no text content surfaced)' });
        }
      } else {
        body.createSpan({ text: '(empty fetch)' });
      }
      return;
    }

    if (type === 'server_tool_use') {
      // Anthropic-server-side tool invocations. Same single-line summary
      // treatment as client tool_use.
      const name = (b.name as string) ?? 'server_tool';
      const input = b.input;
      const row = parent.createDiv({ cls: 'scribian-tool-call' });
      row.createSpan({
        cls: 'scribian-tool-name',
        text: describeToolUse(name, input),
      });
      return;
    }

    // Unknown block type — surface friendly placeholder instead of JSON,
    // which non-developer users find jarring. The block type name is
    // shown so we can debug new Anthropic features.
    const placeholder = parent.createDiv({ cls: 'scribian-block-unknown' });
    placeholder.setText(`(unhandled block: ${type ?? 'unknown'})`);
  }

  // ─── Approval (write tools) ──────────────────────────────────────

  private requestApproval(proposal: WriteProposal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(proposal.toolUseId, { proposal, resolve });
      this.flushRender();
    });
  }

  private resolveApproval(toolUseId: string, approved: boolean): void {
    const entry = this.pendingApprovals.get(toolUseId);
    if (!entry) return;
    this.pendingApprovals.delete(toolUseId);
    // Remove the diff card from the DOM directly. The row that owns the
    // tool_use is finalized so flushRender won't re-walk it; we patch the
    // DOM in place instead.
    const card = this.messagesEl.querySelector(
      `.scribian-diff[data-tool-use-id="${cssEscape(toolUseId)}"]`,
    );
    card?.remove();
    entry.resolve(approved);
  }

  private renderDiffCard(
    parent: HTMLElement,
    proposal: WriteProposal,
    resolve: (approved: boolean) => void,
  ): void {
    void resolve;
    const card = parent.createDiv({ cls: 'scribian-diff' });
    card.setAttr('data-tool-use-id', proposal.toolUseId);

    const header = card.createDiv({ cls: 'scribian-diff-header' });
    const kindLabel = {
      create: '🆕 Create',
      overwrite: '✏️ Overwrite',
      edit: '✏️ Edit',
      append: '➕ Append',
    }[proposal.kind];
    header.createSpan({
      cls: 'scribian-diff-kind',
      text: kindLabel,
    });
    header.createSpan({
      cls: 'scribian-diff-path',
      text: proposal.path,
    });

    const body = card.createDiv({ cls: 'scribian-diff-body' });
    const diff = lineDiff(proposal.before ?? '', proposal.after);
    for (const line of diff) {
      const row = body.createDiv({
        cls: `scribian-diff-line scribian-diff-${line.type}`,
      });
      const marker = row.createSpan({ cls: 'scribian-diff-marker' });
      marker.setText(
        line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ',
      );
      row.createSpan({ cls: 'scribian-diff-text', text: line.text });
    }

    const actions = card.createDiv({ cls: 'scribian-diff-actions' });
    const approve = actions.createEl('button', {
      cls: 'clickable-icon scribian-icon-btn scribian-diff-approve',
      attr: { 'aria-label': 'Approve write' },
    });
    setIcon(approve, 'check');
    setTooltip(approve, 'Approve');
    const reject = actions.createEl('button', {
      cls: 'clickable-icon scribian-icon-btn scribian-diff-reject',
      attr: { 'aria-label': 'Reject write' },
    });
    setIcon(reject, 'x');
    setTooltip(reject, 'Reject');
    approve.addEventListener('click', () =>
      this.resolveApproval(proposal.toolUseId, true),
    );
    reject.addEventListener('click', () =>
      this.resolveApproval(proposal.toolUseId, false),
    );
  }

  private setStatus(text: string, modifier?: 'connected' | 'error'): void {
    this.statusEl.setText(text);
    this.statusEl.removeClass('connected', 'error');
    if (modifier) this.statusEl.addClass(modifier);
  }
}
