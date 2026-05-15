import {
  Component,
  ItemView,
  MarkdownRenderer,
  TFile,
  WorkspaceLeaf,
  setIcon,
  setTooltip,
} from 'obsidian';
import type ScribianPlugin from './main';
import { Transport } from './transport';
import { ChatSession } from './chat-session';
import { MODELS } from './settings';
import { ALL_TOOLS, executeTool } from './tools';
import type { WriteProposal } from './tools';
import { ApprovalManager } from './approval-manager';
import { loadSystemPrompt } from './view/system-prompt';
import { renderMessageActions } from './view/message-actions';
import { renderBlock } from './view/block-renderer';
import { NotePicker } from './view/note-picker';
import {
  attachmentsFromClipboard,
  attachmentsFromFiles,
  clipboardHasImage,
  humanByteCount,
  toImageContentBlock,
  type ImageAttachment,
} from './image-attach';
import { saveConversation } from './conversation-store';
import type { ContentBlock, Message } from '@scribian/protocol';

export const VIEW_TYPE_SCRIBIAN = 'scribian-chat';

const RENDER_THROTTLE_MS = 150;

/** Compact summary of tool input for audit log lines. */
function summarizeToolInput(name: string, input: unknown): string {
  const i = (input as Record<string, any>) ?? {};
  if (name === 'read_note' || name === 'metadata') return `path=${i.path ?? '?'}`;
  if (name === 'list_notes')
    return `folder=${i.folder ?? '(all)'} limit=${i.limit ?? 50}`;
  if (name === 'search_vault') return `query="${i.query ?? '?'}"`;
  if (name === 'current_note') return '';
  return JSON.stringify(input ?? {}).slice(0, 100);
}

// CSS.escape isn't always available; fall back to a regex strip for safety.
function cssEscape(s: string): string {
  if (typeof (window as any).CSS?.escape === 'function') {
    return (window as any).CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
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
  private pickedImages: ImageAttachment[] = [];
  private notePicker!: NotePicker;
  private readonly approvals = new ApprovalManager({
    onPendingChange: () => this.flushRender(),
    onResolve: (proposal, approved) => {
      // Audit: every approval decision is logged so users can review
      // who approved which write at what time. Stays vault-local; never
      // leaves the device.
      this.plugin.logger.info(
        `approval ${approved ? 'approved' : 'rejected'}: ${proposal.kind} ${proposal.path}`,
      );
    },
  });

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
    const settings = this.plugin.settings;
    const provider = settings.provider ?? 'anthropic';

    if (provider === 'anthropic') {
      // Anthropic-direct: small fixed dropdown of Anthropic models.
      this.modelSelect = header.createEl('select', { cls: 'scribian-model' });
      for (const m of MODELS) {
        const opt = this.modelSelect.createEl('option', {
          text: m.label,
          value: m.id,
        });
        if (m.id === settings.defaultModel) opt.selected = true;
      }
      this.modelSelect.addEventListener('change', async () => {
        this.plugin.settings.defaultModel = this.modelSelect.value;
        await this.plugin.saveSettings();
      });
    } else {
      // OpenRouter: hundreds-of-models catalog. The chat header shows
      // the active model as a non-editable label; model selection
      // lives in settings (ModelSuggest fuzzy search). The hidden
      // <select> below is a stand-in so `.value` keeps working — its
      // single option carries the user's configured OpenRouter model.
      // Styles in styles.css (.scribian-model-label).
      const label = header.createEl('span', {
        cls: 'scribian-model-label',
        text: settings.openrouterModel || 'anthropic/claude-sonnet-4-6',
      });
      label.setAttr('title', 'Active OpenRouter model. Change in settings.');
      this.modelSelect = header.createEl('select', {
        cls: 'scribian-model scribian-model-hidden',
      });
      const opt = this.modelSelect.createEl('option', {
        text: settings.openrouterModel,
        value: settings.openrouterModel || 'anthropic/claude-sonnet-4-6',
      });
      opt.selected = true;
    }

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
    const fileInput = buttonRow.createEl('input', {
      cls: 'scribian-file-input',
      attr: {
        type: 'file',
        accept: 'image/jpeg,image/png,image/gif,image/webp',
        multiple: 'true',
        capture: 'environment',
      },
    });
    fileInput.style.display = 'none';
    cameraBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files) void this.handleImageFiles(fileInput.files);
      // Reset so picking the same file twice fires the change event.
      fileInput.value = '';
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

    this.sendBtn.addEventListener('click', () => this.send());
    this.stopBtn.addEventListener('click', () => this.session?.cancel());
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
      onMessage: (msg) => this.handleServerMessage(msg),
      onError: (err) => this.setStatus(`Error: ${err}`, 'error'),
    });
    this.transport.connect();

    this.session = new ChatSession(
      this.transport,
      () => this.modelSelect.value,
      () => loadSystemPrompt(this.app, this.plugin.settings),
      () => {
        const s = this.plugin.settings;
        const provider = s.provider ?? 'anthropic';
        const apiKey =
          provider === 'openrouter'
            ? s.openrouterApiKey || undefined
            : s.anthropicApiKey || undefined;
        return { provider, apiKey };
      },
      ALL_TOOLS,
      (name, input, toolUseId) =>
        executeTool(name, input, toolUseId, {
          app: this.app,
          approve: (proposal) => this.requestApproval(proposal),
          memoryClient: {
            workerUrl: this.plugin.settings.workerUrl,
            workerToken: this.plugin.settings.workerToken,
          },
        }),
      {
        onUpdate: () => this.requestRender(),
        onError: (err) => this.setStatus(`Chat error: ${err}`, 'error'),
        onDone: (stopReason, usage, provider) =>
          this.onTurnDone(stopReason, usage, provider),
      },
    );
    this.requestRender();
  }


  /**
   * Drop text into the chat input from outside the view (e.g. a
   * slash command modal expanding a template). Focuses the input
   * and moves the cursor to the end so the user can review +
   * augment before sending.
   */
  fillInput(text: string): void {
    this.inputEl.value = text;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    // Trigger input event so the @-picker (and any future input
    // listeners) recompute for the new text.
    this.inputEl.dispatchEvent(new Event('input'));
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text && this.pickedImages.length === 0) return;
    if (!this.transport?.isOpen() || !this.session) {
      this.setStatus('Not connected.', 'error');
      return;
    }
    this.inputEl.value = '';
    this.sendBtn.disabled = true;
    this.stopBtn.style.display = '';

    // Build the user turn: text-only when there are no images, or
    // a multi-modal content-block array when images are attached.
    // Image blocks come first so Claude sees the visual context
    // before the question (matches Anthropic's recommended ordering
    // in the Vision guide).
    if (this.pickedImages.length === 0) {
      const augmented = await this.augmentUserText(text);
      void this.session.sendUserText(augmented);
    } else {
      const blocks: ContentBlock[] = [];
      for (const att of this.pickedImages) {
        blocks.push(toImageContentBlock(att));
      }
      const augmented = await this.augmentUserText(text);
      if (augmented) blocks.push({ type: 'text', text: augmented });
      this.pickedImages = [];
      this.renderChip();
      void this.session.sendUserMessage(blocks);
    }
  }

  /**
   * Catch image clipboard data on the input element. Convert to
   * base64 attachments + render chips; the actual image content
   * blocks are built in send() on submit.
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


  private onTurnDone(
    stopReason: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
    provider?: 'anthropic' | 'openrouter',
  ): void {
    this.sendBtn.disabled = false;
    this.stopBtn.style.display = 'none';
    const cache = usage.cache_read_input_tokens
      ? ` (cache hit ${usage.cache_read_input_tokens})`
      : '';
    const stop = stopReason !== 'end_turn' ? ` · ${stopReason}` : '';
    const via = provider === 'openrouter' ? ' · openrouter' : '';
    this.setStatus(
      `Connected · last turn${via}: ${usage.input_tokens} in / ${usage.output_tokens} out${cache}${stop}`,
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

  /**
   * Dispatch incoming Worker messages. mcp_call messages are MCP bridge
   * tool calls from external clients (Claude Code, Cursor, etc.) routed
   * through our Worker — execute locally and reply with mcp_result.
   * Everything else is chat traffic.
   */
  private handleServerMessage(msg: import('@scribian/protocol').ServerMessage): void {
    if (msg.type === 'mcp_call') {
      void this.handleMcpCall(msg.id, msg.name, msg.input, msg.caller_label);
      return;
    }
    this.session?.handleServer(msg);
  }

  private async handleMcpCall(
    id: string,
    name: string,
    input: unknown,
    callerLabel?: string,
  ): Promise<void> {
    if (!this.transport) return;
    const caller = callerLabel ?? 'unknown';
    const inputSummary = summarizeToolInput(name, input);
    this.plugin.logger.info(
      `mcp_call from=${caller} tool=${name} ${inputSummary}`,
    );
    try {
      const result = await executeTool(name, input, id, {
        app: this.app,
        // MCP read-only path: no write tools allowed, so no approval is
        // ever requested. Auto-reject any write-tool approval attempt
        // (defense in depth — Worker also gates writes at the MCP edge).
        approve: async () => false,
        memoryClient: {
          workerUrl: this.plugin.settings.workerUrl,
          workerToken: this.plugin.settings.workerToken,
        },
      });
      if (result.is_error) {
        this.plugin.logger.warn(
          `mcp_call error from=${caller} tool=${name}: ${result.content.slice(0, 200)}`,
        );
      } else {
        this.plugin.logger.info(
          `mcp_call ok from=${caller} tool=${name} bytes=${result.content.length}`,
        );
      }
      this.transport.send({
        type: 'mcp_result',
        id,
        content: result.content,
        ...(result.is_error ? { is_error: true } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'tool execution failed';
      this.plugin.logger.error(`mcp_call exception from=${caller} tool=${name}: ${msg}`);
      this.transport.send({
        type: 'mcp_result',
        id,
        content: msg,
        is_error: true,
      });
    }
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

    const blockCtx = this.blockContext(row.component);

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        const wrap = row.body.createDiv({ cls: 'scribian-text' });
        wrap.addClass('markdown-rendered');
        await MarkdownRenderer.render(
          this.app,
          msg.content,
          wrap,
          '',
          row.component,
        );
      }
      return;
    }

    for (const block of msg.content) {
      await renderBlock(row.body, block, blockCtx);
    }

    // Per-message action row at the bottom of every finalized Claude turn.
    // Hover-based actions don't work on mobile, so these are always visible.
    if (msg.role === 'assistant' && !isInFlight) {
      renderMessageActions(row.el, msg, {
        app: this.app,
        savedNotesFolder: this.plugin.settings.savedNotesFolder,
      });
    }
  }


  private blockContext(component: Component) {
    return {
      app: this.app,
      component,
      pendingApproval: (id: string) => this.approvals.get(id)?.proposal ?? null,
      onApprove: (id: string) => this.resolveApprovalUi(id, true),
      onReject: (id: string) => this.resolveApprovalUi(id, false),
    };
  }


  // ─── Approval (write tools) ──────────────────────────────────────

  private requestApproval(proposal: WriteProposal): Promise<boolean> {
    return this.approvals.request(proposal);
  }

  /**
   * User clicked approve/reject on a diff card. Resolves the
   * underlying approval Promise (and triggers the onResolve hook
   * for audit-logging) before clipping the diff card from the DOM.
   * The DOM removal happens here rather than via re-render because
   * the row owning the tool_use is finalized — flushRender won't
   * re-walk it, so we patch the DOM in place.
   */
  private resolveApprovalUi(toolUseId: string, approved: boolean): void {
    if (!this.approvals.resolve(toolUseId, approved)) return;
    const card = this.messagesEl.querySelector(
      `.scribian-diff[data-tool-use-id="${cssEscape(toolUseId)}"]`,
    );
    card?.remove();
  }


  private setStatus(text: string, modifier?: 'connected' | 'error'): void {
    this.statusEl.setText(text);
    this.statusEl.removeClass('connected', 'error');
    if (modifier) this.statusEl.addClass(modifier);
  }
}
