import { ItemView, WorkspaceLeaf, setIcon, setTooltip } from 'obsidian';
import type SkaldPlugin from './main';
import type { SkaldTransport } from './transport-interface';
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
import { LiveRegion } from './view/live-region';
import { maybeRenderSetupBanner } from './view/setup-banner';
import { connectSession } from './view/connect-session';
import { resumeConversation } from './view/resume-conversation';
import { toImageContentBlock } from './image-attach';
import { persistConversation } from './view/persist-conversation';
import { estimateTurnCost, formatTurnStatus, formatSessionFooter } from './pricing';
import { ConversationSearchModal } from './conversation-search';
import type { ContentBlock, Provider } from '@skald/protocol';
import { isUpkeepDue } from './memory-upkeep';
import { runMemoryUpkeepView, UpkeepInFlightGate } from './view/memory-upkeep-view';

export const VIEW_TYPE_SKALD = 'skald-chat';

export class SkaldView extends ItemView {
  private plugin: SkaldPlugin;
  private transport: SkaldTransport | null = null;
  private session: ChatSession | null = null;
  private modelSelect!: HTMLSelectElement;
  private statusEl!: HTMLDivElement;
  private composer!: Composer;
  private messageList!: MessageList;
  private liveRegion!: LiveRegion;
  private activeNote: ActiveNoteIndicator | null = null;
  private usageFooterEl!: HTMLDivElement;
  /** Turns since the last memory-upkeep pass. Resets to 0 after
   * each successful upkeep trigger; also resets on new chat. */
  private turnsSinceUpkeep = 0;
  /** In-flight gate (see UpkeepInFlightGate): held while an upkeep pass runs
   * or awaits approval, so overlapping passes can't clobber the note. */
  private readonly upkeepGate = new UpkeepInFlightGate();
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

  constructor(leaf: WorkspaceLeaf, plugin: SkaldPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  override getViewType(): string {
    return VIEW_TYPE_SKALD;
  }

  override getDisplayText(): string {
    return 'Skald';
  }

  override getIcon(): string {
    return 'message-square';
  }

  override async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('skald-root');
    root.setAttrs({ role: 'region', 'aria-label': 'Skald chat' });

    // Polite live region for screen-reader announcement of finalized
    // assistant replies. Mounted first so it exists before the first
    // turn finalizes; visually hidden (.skald-sr-only).
    this.liveRegion = new LiveRegion(root);

    const refs = renderHeader(root, this.plugin.settings, {
      onModelChange: async (newModel) => {
        this.plugin.settings.defaultModel = newModel;
        await this.plugin.saveSettings();
      },
      onNewChat: () => this.resetChat(),
      onHistory: () => this.openHistoryModal(),
    });
    this.modelSelect = refs.modelSelect;

    const statusRow = root.createDiv({ cls: 'skald-status-row' });
    this.statusEl = statusRow.createDiv({ cls: 'skald-status' });
    const reconnectBtn = statusRow.createEl('button', {
      cls: 'clickable-icon skald-icon-btn',
      attr: { 'aria-label': 'Reconnect' },
    });
    setIcon(reconnectBtn, 'rotate-cw');
    setTooltip(reconnectBtn, 'Reconnect');
    reconnectBtn.addEventListener('click', () => this.reconnect());
    this.setStatus('Disconnected');

    this.activeNote = new ActiveNoteIndicator(
      root,
      this.app,
      { onAttach: (file) => this.composer?.attachFile(file) },
      this,
    );

    maybeRenderSetupBanner(root, this.app, {
      provider: this.plugin.settings.provider,
      anthropicApiKey: this.plugin.settings.anthropicApiKey,
      openrouterApiKey: this.plugin.settings.openrouterApiKey,
      openaiBaseUrl: this.plugin.settings.openaiBaseUrl,
    });

    this.messageList = new MessageList(root, {
      app: this.app,
      host: this,
      pendingApproval: (id) => this.approvals.get(id)?.proposal ?? null,
      onApprove: (id) => this.resolveApprovalUi(id, true),
      onReject: (id) => this.resolveApprovalUi(id, false),
      savedNotesFolder: this.plugin.settings.savedNotesFolder,
      getDocumentRegistry: () => this.session?.documentRegistry ?? new Map(),
      announce: (text) => this.liveRegion.announce(text),
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

    this.usageFooterEl = root.createDiv({ cls: 'skald-usage-footer' });
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
    this.liveRegion?.clear();
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
    this.liveRegion.clear();
    this.dropSessionState();
    this.turnsSinceUpkeep = 0;
    if (this.usageFooterEl) this.usageFooterEl.style.display = 'none';
    this.requestRender();
  }

  private reconnect(): void {
    this.transport?.close();
    this.transport = null;
    this.session = null;
    this.messageList.tearDown();
    this.liveRegion.clear();
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

    // Fix 5: wrap augment+dispatch in try/catch so a context-augmentation
    // error doesn't leave the composer locked.
    try {
      if (pickedImages.length === 0) {
        const augmented = await this.augmentUserText(text);
        await this.session.sendUserText(augmented);
      } else {
        const blocks: ContentBlock[] = [];
        for (const att of pickedImages) blocks.push(toImageContentBlock(att));
        const augmented = await this.augmentUserText(text);
        if (augmented) blocks.push({ type: 'text', text: augmented });
        this.composer.clearImages();
        await this.session.sendUserMessage(blocks);
      }
    } catch (err) {
      this.composer.setBusy(false);
      this.setStatus(err instanceof Error ? err.message : 'Send failed.', 'error');
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
    provider?: Provider,
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
    const footerText = formatSessionFooter(
      total,
      this.modelSelect.value,
      this.plugin.sessionCostUSD,
    );
    this.usageFooterEl.setText(footerText);
    this.usageFooterEl.style.display = '';
    void this.flushRender();
    void this.persistConversation();
    // Memory upkeep: fire after the turn is shown (off the hot path); never blocks rendering — errors soft-fail silently.
    this.turnsSinceUpkeep++;
    if (isUpkeepDue(this.turnsSinceUpkeep)) {
      this.turnsSinceUpkeep = 0;
      void this.runMemoryUpkeep(provider);
    }
  }

  private runMemoryUpkeep(provider: Provider | undefined): Promise<void> {
    // In-flight gate + conversationId race guard both live in runMemoryUpkeepView.
    return runMemoryUpkeepView({
      app: this.app,
      settings: this.plugin.settings,
      session: this.session,
      approvals: this.approvals,
      provider,
      getActiveConversationId: () => this.session?.conversationId,
      inFlight: this.upkeepGate,
    });
  }

  private persistConversation(): Promise<void> {
    return persistConversation(
      this.app,
      this.session,
      this.plugin.settings.chatsFolder,
      this.modelSelect.value,
    );
  }

  private handleServerMessage(msg: import('@skald/protocol').ServerMessage): void {
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
