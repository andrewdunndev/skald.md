import { ItemView, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type ScribianPlugin from './main';
import type { ScribianTransport } from './transport-interface';
import { ChatSession } from './chat-session';
import type { WriteProposal } from './tools';
import { ApprovalManager } from './approval-manager';
import { ActiveNoteIndicator } from './view/active-note';
import { Composer } from './view/composer';
import { loadStarterChips } from './view/empty-state';
import { renderHeader } from './view/header';
import { augmentUserText } from './view/augment-user-text';
import { readsBeforeToolUse } from './view/inflight-reads';
import { MessageList } from './view/message-list';
import { maybeRenderSetupBanner } from './view/setup-banner';
import { connectSession } from './view/connect-session';
import { resumeConversation } from './view/resume-conversation';
import { toImageContentBlock } from './image-attach';
import { saveConversation } from './conversation-store';
import { estimateTurnCost, formatTurnStatus, formatSessionFooter } from './pricing';
import { ConversationSearchModal } from './conversation-search';
import type { ContentBlock } from '@scribian/protocol';

export const VIEW_TYPE_SCRIBIAN = 'scribian-chat';

export class ScribianView extends ItemView {
  private plugin: ScribianPlugin;
  private transport: ScribianTransport | null = null;
  private session: ChatSession | null = null;
  private modelSelect!: HTMLSelectElement;
  private statusEl!: HTMLDivElement;
  private composer!: Composer;
  private messageList!: MessageList;
  private activeNote: ActiveNoteIndicator | null = null;
  private usageFooterEl!: HTMLDivElement;
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

    const refs = renderHeader(root, this.plugin.settings, {
      onModelChange: async (newModel) => {
        this.plugin.settings.defaultModel = newModel;
        await this.plugin.saveSettings();
      },
      onNewChat: () => this.resetChat(),
      onHistory: () => this.openHistoryModal(),
    });
    this.modelSelect = refs.modelSelect;

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

    this.activeNote = new ActiveNoteIndicator(root, this.app, {
      onAttach: (file) => this.composer?.attachFile(file),
    });

    maybeRenderSetupBanner(root, this.app, {
      connectionMode: this.plugin.settings.connectionMode ?? 'direct',
      workerUrl: this.plugin.settings.workerUrl,
      workerToken: this.plugin.settings.workerToken,
      provider: this.plugin.settings.provider,
      anthropicApiKey: this.plugin.settings.anthropicApiKey,
      openrouterApiKey: this.plugin.settings.openrouterApiKey,
    });

    this.messageList = new MessageList(root, {
      app: this.app,
      host: this,
      pendingApproval: (id) => this.approvals.get(id)?.proposal ?? null,
      onApprove: (id) => this.resolveApprovalUi(id, true),
      onReject: (id) => this.resolveApprovalUi(id, false),
      savedNotesFolder: this.plugin.settings.savedNotesFolder,
      onStarterPick: (chip) => {
        if (!this.composer) return;
        this.composer.fillText(chip.prompt);
        if (chip.attachImage) this.composer.pickImage();
      },
      onSuggestWrite: (path) => {
        if (!this.composer) return;
        this.composer.fillText(
          `Propose a write_note or append_to_note targeting \`${path}\` with the content from your last message. I'll approve via the diff card.`,
        );
      },
      loadStarterChips: () =>
        loadStarterChips(this.app, this.plugin.settings.startersPath),
    });

    this.usageFooterEl = root.createDiv({ cls: 'scribian-usage-footer' });
    this.usageFooterEl.style.display = 'none';

    this.composer = new Composer(root, this.app, {
      onSend: () => void this.send(),
      onStop: () => this.session?.cancel(),
    });

    this.connect();
  }

  override async onClose(): Promise<void> {
    this.activeNote?.dispose();
    this.activeNote = null;
    this.messageList?.cancelPendingRender();
    this.messageList?.tearDown();
    this.dropSessionState();
    this.transport?.close();
    this.transport = null;
    this.session = null;
  }

  /** Shared cleanup for new-chat / reconnect / close. Resolves
   * pending approvals as rejected so runner Promises don't dangle,
   * drops picked attachments so previous-chat context doesn't
   * bleed into the next message via augmentUserText, and resets
   * composer busy so mid-stream disconnects don't leave it locked. */
  private dropSessionState(): void {
    this.approvals.abandonAll();
    this.composer?.clearAttachments();
    this.composer?.setBusy(false);
  }

  private resetChat(): void {
    // Roll the cleared chat's cost into the app-session cumulative so
    // the session figure survives New Chat. In-memory on the plugin;
    // never persisted, resets on plugin reload.
    if (this.session) {
      this.plugin.sessionCostUSD += estimateTurnCost(
        this.session.getTotalUsage(),
        this.modelSelect.value,
      );
    }
    this.session?.reset();
    this.messageList.tearDown();
    this.dropSessionState();
    if (this.usageFooterEl) this.usageFooterEl.style.display = 'none';
    this.requestRender();
  }

  private reconnect(): void {
    this.transport?.close();
    this.transport = null;
    this.session = null;
    this.messageList.tearDown();
    this.dropSessionState();
    this.connect();
  }

  private openHistoryModal(): void {
    const folder = this.plugin.settings.chatsFolder?.trim() ?? '';
    new ConversationSearchModal(this.app, folder, {
      onResume: (file) =>
        void resumeConversation(file, {
          app: this.app,
          session: this.session,
          connect: () => this.connect(),
          messageList: this.messageList,
          dropSessionState: () => this.dropSessionState(),
          getModelValue: () => this.modelSelect.value,
          getTransport: () => this.transport,
          setTransport: () => { this.transport = null; },
          setSession: () => { this.session = null; },
          usageFooterEl: this.usageFooterEl,
          onPreClear: (cost) => { this.plugin.sessionCostUSD += cost; },
        }),
    }).open();
  }

  private connect(): void {
    const result = connectSession(this.app, this.plugin, {
      setStatus: (t, m) => this.setStatus(t, m),
      handleServerMessage: (msg) => this.handleServerMessage(msg),
      requestRender: () => this.requestRender(),
      requestApproval: (proposal) =>
        this.requestApproval({
          ...proposal,
          informedBy: this.currentTurnReads(proposal.toolUseId),
        }),
      getModelValue: () => this.modelSelect.value,
      currentTurnReads: (id) => this.currentTurnReads(id),
      onDone: (stopReason, usage, provider) =>
        this.onTurnDone(stopReason, usage, provider),
      onTurnAborted: () => this.composer?.setBusy(false),
    });
    if (!result) return;
    this.transport = result.transport;
    this.session = result.session;
    this.requestRender();
  }

  /**
   * Drop text into the chat input from outside the view (e.g. a
   * slash command modal expanding a template). Delegates to the
   * composer.
   */
  fillInput(text: string): void {
    this.composer.fillText(text);
  }

  private async send(): Promise<void> {
    const text = this.composer.text().trim();
    const pickedImages = this.composer.attachedImages();
    if (!text && pickedImages.length === 0) return;
    if (!this.transport?.isOpen() || !this.session) {
      this.setStatus('Not connected.', 'error');
      return;
    }
    this.composer.clearInput();
    this.composer.setBusy(true);

    // Build the user turn: text-only when there are no images, or
    // a multi-modal content-block array when images are attached.
    // Image blocks come first so Claude sees the visual context
    // before the question (matches Anthropic's recommended ordering
    // in the Vision guide).
    if (pickedImages.length === 0) {
      const augmented = await this.augmentUserText(text);
      void this.session.sendUserText(augmented);
    } else {
      const blocks: ContentBlock[] = [];
      for (const att of pickedImages) {
        blocks.push(toImageContentBlock(att));
      }
      const augmented = await this.augmentUserText(text);
      if (augmented) blocks.push({ type: 'text', text: augmented });
      this.composer.clearImages();
      void this.session.sendUserMessage(blocks);
    }
  }

  private async augmentUserText(text: string): Promise<string> {
    return augmentUserText(this.app, text, this.composer.attachedFiles());
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
    this.composer.setBusy(false);
    const total = this.session?.getTotalUsage() ?? usage;
    this.setStatus(
      formatTurnStatus({
        usage,
        model: this.modelSelect.value,
        provider,
        stopReason,
      }),
      'connected',
    );
    // Update the live cost footer below the message list. Includes the
    // app-session cumulative (prior cleared chats + this chat) so users
    // can see the running total isn't unbounded.
    const footerText = formatSessionFooter(
      total,
      this.modelSelect.value,
      this.plugin.sessionCostUSD,
    );
    this.usageFooterEl.setText(footerText);
    this.usageFooterEl.style.display = '';
    // Force a final render to lock the finalized message rendering.
    void this.flushRender();
    // Persist the conversation to the configured chats folder. Errors are
    // swallowed inside saveConversation; users see the file in their vault.
    void this.persistConversation();
  }

  private async persistConversation(): Promise<void> {
    if (!this.session) return;
    const folder = this.plugin.settings.chatsFolder.trim();
    if (!folder) return;
    const totalUsage = this.session.getTotalUsage();
    const costUSD = estimateTurnCost(totalUsage, this.modelSelect.value);
    await saveConversation(
      this.app,
      folder,
      {
        id: this.session.conversationId,
        model: this.modelSelect.value,
        created: this.session.conversationCreated,
        updated: new Date().toISOString(),
        usage: totalUsage,
        costUSD,
      },
      this.session.getMessages(),
    );
  }

  private handleServerMessage(msg: import('@scribian/protocol').ServerMessage): void {
    this.session?.handleServer(msg);
  }

  private requestRender(): void {
    const s = this.session;
    if (!s) return;
    this.messageList.requestRender(
      () => s.getMessages(),
      () => s.getInFlight(),
    );
  }

  private async flushRender(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.messageList.flushRender(s.getMessages(), s.getInFlight());
  }

  private requestApproval(proposal: WriteProposal): Promise<boolean> {
    return this.approvals.request(proposal);
  }

  private currentTurnReads(currentToolUseId: string): string[] {
    const inFlight = this.session?.getInFlight();
    if (!inFlight) return [];
    return readsBeforeToolUse(inFlight.blocks, currentToolUseId);
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
    this.messageList.queryDiff(toolUseId)?.remove();
  }

  private setStatus(text: string, modifier?: 'connected' | 'error'): void {
    this.statusEl.setText(text);
    this.statusEl.removeClass('connected', 'error');
    if (modifier) this.statusEl.addClass(modifier);
  }
}
