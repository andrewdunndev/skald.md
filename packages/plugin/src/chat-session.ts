import type {
  ChatRequest,
  ClientMessage,
  ContentBlock,
  Message,
  Provider,
  ServerMessage,
  ToolDefinition,
  Usage,
} from '@skald/protocol';
import { sumUsage } from './pricing';
import { windowHistory, compactStaleToolResults } from './history-window';
import type { SkaldTransport } from './transport-interface';
import { parseCitationLocation } from './citations';
import { executeToolLeg } from './chat-session-tool-loop';

export interface InFlight {
  id: string;
  blocks: ContentBlock[];
  usage: Usage;
}

export interface ChatSessionHandlers {
  onUpdate: () => void;
  /** Surface a turn failure. `opts.retryable` (when true) signals the
   * transport judged the error transient (429 / 5xx / network) so the
   * view can offer a one-tap Resend of the last user turn. */
  onError: (err: string, opts?: { retryable?: boolean }) => void;
  onDone: (stopReason: string, usage: Usage, provider?: Provider) => void;
}

/** Synthetic transcript block: a failed turn surfaced inline in the
 * chat (not only in the status row) so the user sees the failure where
 * they're looking. `retryable` drives the inline Resend affordance. */
export interface SkaldErrorBlock {
  type: 'skald_error';
  text: string;
  retryable: boolean;
}

/** True when a message is a synthetic inline-error message (its content
 * is solely skald_error display blocks). Such messages are transcript-
 * only and must never be sent upstream. */
function isErrorMessage(msg: Message): boolean {
  return (
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    msg.content.every((b) => (b as Record<string, unknown>).type === 'skald_error')
  );
}

/** Drop synthetic inline-error messages before dispatch to a provider. */
const stripErrorMessages = (messages: Message[]): Message[] =>
  messages.filter((m) => !isErrorMessage(m));

export interface ToolExecutor {
  (
    name: string,
    input: unknown,
    toolUseId: string,
  ): Promise<{ content: string; is_error?: boolean }>;
}

/**
 * Resolved per-turn provider configuration. `apiKey` is the
 * plugin-supplied key for the active provider, sent directly to the
 * upstream API. `provider` selects which upstream to call
 * (Anthropic or OpenRouter).
 */
export interface ProviderConfig {
  provider: Provider;
  apiKey?: string;
  /** OpenAI-compatible base URL (provider==='openai' only). */
  baseUrl?: string;
}

/** Maximum number of tool-execution legs allowed per user turn.
 * When this limit is reached the loop stops and a user-facing notice
 * is surfaced via onError so the composer unlocks. */
export const MAX_TOOL_LEGS = 20;

export class ChatSession {
  private readonly messages: Message[] = [];
  private inFlight: InFlight | null = null;
  private totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  /** Counts tool-execution legs within the current user turn. Reset to 0
   * at the start of each new user turn (sendUserMessage). */
  private toolLegCount = 0;
  conversationId: string = crypto.randomUUID();
  conversationCreated: string = new Date().toISOString();
  /** document_index → vault path. Populated by executeToolsAndContinue
   * when citations are enabled; cleared on each new user turn. */
  readonly documentRegistry = new Map<number, string>();

  constructor(
    private readonly transport: SkaldTransport,
    private readonly modelProvider: () => string,
    private readonly systemProvider: () => Promise<ChatRequest['system']>,
    private readonly providerConfigProvider: () => ProviderConfig,
    private readonly toolDefinitionsProvider: () => ToolDefinition[],
    private readonly toolExecutor: ToolExecutor,
    private readonly handlers: ChatSessionHandlers,
    /** Optional: citations path gate. */
    private readonly citationsEnabledProvider?: () => boolean,
  ) {}

  async sendUserText(text: string): Promise<void> {
    return this.sendUserMessage(text);
  }

  /**
   * Generalized user-turn entry point. Accepts a plain string
   * (legacy) or an array of content blocks (for multi-modal turns
   * with image / document attachments). The two shapes share the
   * dispatch path — content blocks just flow through the
   * Anthropic-canonical message shape unchanged.
   */
  async sendUserMessage(content: string | ContentBlock[]): Promise<void> {
    if (this.inFlight) {
      this.handlers.onError('A response is already in flight.');
      return;
    }
    this.documentRegistry.clear();
    this.toolLegCount = 0;
    this.messages.push({ role: 'user', content });
    this.handlers.onUpdate();
    await this.dispatch();
  }

  cancel(): void {
    if (!this.inFlight) return;
    this.transport.send({ type: 'cancel', id: this.inFlight.id });
  }

  handleServer(msg: ServerMessage): void {
    if (msg.type === 'chunk') {
      this.handleChunk(msg.event, msg.data);
      return;
    }
    if (msg.type === 'done') {
      if (!this.inFlight) return; // guard: mid-stream error already cleared inFlight
      void this.finalize(msg.stop_reason, msg.usage, msg.provider).catch((err) => {
        this.inFlight = null;
        this.handlers.onError(err instanceof Error ? err.message : 'Unexpected error.');
        this.handlers.onUpdate();
      });
      return;
    }
    if (msg.type === 'error') {
      this.inFlight = null;
      this.failTurn(msg.error, msg.retryable === true);
    }
  }

  /**
   * Surface a turn failure inline in the transcript (visible where the
   * user is looking, not only in the status row) AND via onError (keeps
   * the status-row + composer-unlock behavior). The inline block carries
   * the retryable flag so the view can render a one-tap Resend; the last
   * user turn stays in `messages` for resendLast() to re-dispatch.
   */
  private failTurn(error: string, retryable: boolean): void {
    const block: SkaldErrorBlock = { type: 'skald_error', text: error, retryable };
    this.messages.push({ role: 'assistant', content: [block as unknown as ContentBlock] });
    this.handlers.onError(error, { retryable });
    this.handlers.onUpdate();
  }

  /**
   * Re-send the last user turn after a retryable failure: drop the
   * trailing inline error message back to the last user turn, then
   * re-dispatch. No-op (returns false) if a turn is in flight or there's
   * no user turn to resend.
   */
  async resendLast(): Promise<boolean> {
    if (this.inFlight) return false;
    // Pop trailing inline-error messages so the last message is the user
    // turn we re-dispatch. Only error messages are popped — a real
    // assistant turn is never discarded.
    while (this.messages.length > 0 && isErrorMessage(this.messages[this.messages.length - 1])) {
      this.messages.pop();
    }
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'user') return false;
    this.toolLegCount = 0;
    this.documentRegistry.clear();
    this.handlers.onUpdate();
    await this.dispatch();
    return true;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getInFlight(): InFlight | null {
    return this.inFlight;
  }

  isInFlight(): boolean {
    return this.inFlight !== null;
  }

  /** Cumulative usage across every finalized turn in this
   * conversation. Reset when reset() is called (new chat). */
  getTotalUsage(): Usage {
    return this.totalUsage;
  }

  reset(): void {
    this.messages.length = 0;
    this.inFlight = null;
    this.totalUsage = { input_tokens: 0, output_tokens: 0 };
    this.documentRegistry.clear();
    this.conversationId = crypto.randomUUID();
    this.conversationCreated = new Date().toISOString();
    this.handlers.onUpdate();
  }

  /**
   * Seed the session from a previously saved conversation.
   * Passive load — does NOT trigger onUpdate or onDone.
   * Silently ignored when a turn is in flight.
   */
  hydrate(opts: {
    conversationId: string;
    model?: string;
    messages: Message[];
    usage?: Usage;
  }): void {
    if (this.inFlight) return;
    this.conversationId = opts.conversationId;
    this.messages.length = 0;
    for (const m of opts.messages) this.messages.push(m);
    this.totalUsage = opts.usage ? { ...opts.usage } : { input_tokens: 0, output_tokens: 0 };
  }

  private async dispatch(): Promise<void> {
    const id = crypto.randomUUID();
    this.inFlight = { id, blocks: [], usage: { input_tokens: 0, output_tokens: 0 } };

    try { // outer catch: sync throw clears inFlight + surfaces onError
      let system: ChatRequest['system'];
      try {
        system = await this.systemProvider();
      } catch (err) {
        this.inFlight = null;
        this.failTurn(err instanceof Error ? err.message : 'Failed to build system prompt.', false);
        return;
      }

      const { provider, apiKey, baseUrl } = this.providerConfigProvider();
      const payload: ChatRequest = {
        model: this.modelProvider(),
        // Strip synthetic skald_error display blocks before windowing —
        // they're transcript-only and would be invalid upstream content.
        messages: compactStaleToolResults(windowHistory(stripErrorMessages(this.messages))),
        max_tokens: 4096,
      };
      if (system) payload.system = system;
      const tools = this.toolDefinitionsProvider();
      if (tools.length > 0) payload.tools = tools;

      const msg: ClientMessage = { type: 'chat', id, payload, provider };
      if (apiKey) {
        if (provider === 'openrouter') msg.openrouter_api_key = apiKey;
        else if (provider === 'openai') msg.openai_api_key = apiKey;
        else msg.anthropic_api_key = apiKey;
      }
      if (provider === 'openai' && baseUrl) msg.openai_base_url = baseUrl;
      this.transport.send(msg);
      this.handlers.onUpdate();
    } catch (err) {
      this.inFlight = null;
      this.failTurn(err instanceof Error ? err.message : 'Unexpected error starting request.', false);
    }
  }

  private handleChunk(event: string, data: unknown): void {
    if (!this.inFlight) return;
    const d = data as Record<string, any> | null;
    if (!d) return;
    const blocks = this.inFlight.blocks;

    if (event === 'content_block_start') {
      blocks[d.index] = { ...(d.content_block as object) };
    } else if (event === 'content_block_delta') {
      const block = blocks[d.index] as Record<string, any> | undefined;
      if (!block) return;
      const delta = d.delta as Record<string, any>;
      if (delta.type === 'text_delta') {
        block.text = (block.text ?? '') + delta.text;
      } else if (delta.type === 'citations_delta') {
        // Accumulate citation objects onto the current text block.
        // Each citations_delta carries a single citation object;
        // we push it onto the block's `citations` array so the
        // finalized block matches the Citations API response shape.
        const citation = parseCitationLocation(delta.citation);
        if (citation) {
          if (!Array.isArray(block.citations)) block.citations = [];
          (block.citations as unknown[]).push(citation);
        }
      } else if (delta.type === 'input_json_delta') {
        block.partial_json = (block.partial_json ?? '') + delta.partial_json;
      } else if (delta.type === 'thinking_delta') {
        block.thinking = (block.thinking ?? '') + delta.thinking;
      } else if (delta.type === 'signature_delta') {
        block.signature = delta.signature;
      }
    } else if (event === 'content_block_stop') {
      const block = blocks[d.index] as Record<string, any> | undefined;
      if (block?.type === 'tool_use' && typeof block.partial_json === 'string') {
        try {
          block.input = JSON.parse(block.partial_json);
        } catch {
          block.input = {};
        }
        delete block.partial_json;
      }
    } else if (event === 'message_start') {
      if (d.message?.usage && this.inFlight) {
        this.inFlight.usage = { ...this.inFlight.usage, ...d.message.usage };
      }
    } else if (event === 'message_delta') {
      if (d.usage && this.inFlight) {
        this.inFlight.usage = { ...this.inFlight.usage, ...d.usage };
      }
    } else if (event === 'error') {
      // Mid-stream SSE error (overloaded_error etc.) — clear inFlight so the
      // composer unlocks; trailing done is ignored (handleServer guards inFlight).
      const ep = d as Record<string, any>;
      const m = (ep?.error as Record<string, unknown> | undefined)?.message;
      this.inFlight = null;
      // Mid-stream provider errors (overloaded_error etc.) are transient,
      // so offer Resend.
      this.failTurn(
        m != null ? String(m) : typeof ep?.message === 'string' ? ep.message : 'Stream error from provider.',
        true,
      );
      return;
    }

    this.handlers.onUpdate();
  }

  private async finalize(
    stopReason: string,
    usage: Usage,
    provider?: Provider,
  ): Promise<void> {
    if (!this.inFlight) return;
    const blocks = this.inFlight.blocks;
    const finalUsage = { ...this.inFlight.usage, ...usage };

    this.messages.push({ role: 'assistant', content: blocks });
    this.inFlight = null;
    this.handlers.onUpdate();

    if (stopReason === 'tool_use') {
      // Mid-turn tool dispatch: accumulate this leg's usage now;
      // the continuation's onDone won't fire until tools resolve +
      // the model responds again.
      this.totalUsage = sumUsage(this.totalUsage, finalUsage);
      this.toolLegCount++;
      if (this.toolLegCount >= MAX_TOOL_LEGS) {
        this.handlers.onError(
          `Stopped after ${MAX_TOOL_LEGS} tool steps — ask a narrower question.`,
        );
        this.handlers.onUpdate();
        return;
      }
      await this.executeToolsAndContinue(blocks);
      return;
    }

    this.totalUsage = sumUsage(this.totalUsage, finalUsage);
    this.handlers.onDone(stopReason, finalUsage, provider);
    this.handlers.onUpdate();
  }

  private async executeToolsAndContinue(blocks: ContentBlock[]): Promise<void> {
    // Clear per-leg: document_index is per-request; accumulating across legs mis-resolves.
    this.documentRegistry.clear();

    const results = await executeToolLeg(
      {
        toolExecutor: this.toolExecutor,
        citationsEnabled: this.citationsEnabledProvider?.() ?? false,
        documentRegistry: this.documentRegistry,
      },
      blocks,
    );
    if (results.length === 0) return;

    this.messages.push({ role: 'user', content: results });
    this.handlers.onUpdate();

    await this.dispatch();
  }
}
