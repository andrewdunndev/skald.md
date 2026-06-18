import type {
  ChatRequest,
  ClientMessage,
  ContentBlock,
  Message,
  Provider,
  ServerMessage,
  ToolDefinition,
  Usage,
} from '@scribian/protocol';
import { sumUsage } from './pricing';
import { windowHistory, compactStaleToolResults } from './history-window';
import { isReadOnlyTool } from './tools';
import type { ScribianTransport } from './transport-interface';
import { buildDocumentBlock, parseCitationLocation } from './citations';

export interface InFlight {
  id: string;
  blocks: ContentBlock[];
  usage: Usage;
}

export interface ChatSessionHandlers {
  onUpdate: () => void;
  onError: (err: string) => void;
  onDone: (stopReason: string, usage: Usage, provider?: Provider) => void;
}

export interface ToolExecutor {
  (
    name: string,
    input: unknown,
    toolUseId: string,
  ): Promise<{ content: string; is_error?: boolean }>;
}

/**
 * Resolved per-turn provider configuration. `apiKey` is the
 * plugin-supplied key for the active provider; if absent the Worker
 * falls back to its own secret. `provider` selects which upstream
 * the Worker dispatches to.
 */
export interface ProviderConfig {
  provider: Provider;
  apiKey?: string;
}

export class ChatSession {
  private readonly messages: Message[] = [];
  private inFlight: InFlight | null = null;
  private totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  conversationId: string = crypto.randomUUID();
  conversationCreated: string = new Date().toISOString();
  /** document_index → vault path. Populated by executeToolsAndContinue
   * when citations are enabled; cleared on each new user turn. */
  readonly documentRegistry = new Map<number, string>();

  constructor(
    private readonly transport: ScribianTransport,
    private readonly modelProvider: () => string,
    private readonly systemProvider: () => Promise<string | undefined>,
    private readonly providerConfigProvider: () => ProviderConfig,
    /** Per-turn provider of the active tool set. Reading at
     * dispatch time lets setting changes (memory enabled/disabled,
     * future model-capability gating) apply on the next turn
     * without recreating the session. */
    private readonly toolDefinitionsProvider: () => ToolDefinition[],
    private readonly toolExecutor: ToolExecutor,
    private readonly handlers: ChatSessionHandlers,
    /** Optional: when true, read_note results are additionally injected
     * as document blocks in the tool-result turn (citations path).
     * Gate: only set when providerCapabilities(provider).citations. */
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
      void this.finalize(msg.stop_reason, msg.usage, msg.provider);
      return;
    }
    if (msg.type === 'error') {
      this.handlers.onError(msg.error);
      this.inFlight = null;
      this.handlers.onUpdate();
    }
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
   * Seed the session from a previously saved conversation. Restores
   * the conversation id (so subsequent saves update the same file),
   * replaces the message history, and restores cumulative usage so
   * the cost footer continues from where the saved chat left off.
   *
   * Passive load — does NOT trigger onUpdate or onDone. Only allowed
   * when no turn is in flight; silently ignored otherwise.
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
    if (opts.usage) {
      this.totalUsage = { ...opts.usage };
    } else {
      this.totalUsage = { input_tokens: 0, output_tokens: 0 };
    }
    // conversationCreated stays as-is (new session startup time);
    // the actual created timestamp lives in the saved file meta and
    // is passed through when persistConversation re-saves.
  }

  private async dispatch(): Promise<void> {
    const id = crypto.randomUUID();
    this.inFlight = {
      id,
      blocks: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    const system = await this.systemProvider();
    const { provider, apiKey } = this.providerConfigProvider();

    const payload: ChatRequest = {
      model: this.modelProvider(),
      messages: compactStaleToolResults(windowHistory(this.messages)),
      max_tokens: 4096,
    };
    if (system) payload.system = system;
    const tools = this.toolDefinitionsProvider();
    if (tools.length > 0) payload.tools = tools;

    const msg: ClientMessage = {
      type: 'chat',
      id,
      payload,
      provider,
    };
    if (apiKey) {
      if (provider === 'openrouter') {
        msg.openrouter_api_key = apiKey;
      } else {
        msg.anthropic_api_key = apiKey;
      }
    }
    this.transport.send(msg);
    this.handlers.onUpdate();
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
      await this.executeToolsAndContinue(blocks);
      return;
    }

    this.totalUsage = sumUsage(this.totalUsage, finalUsage);
    this.handlers.onDone(stopReason, finalUsage, provider);
    this.handlers.onUpdate();
  }

  private async executeToolsAndContinue(blocks: ContentBlock[]): Promise<void> {
    const toolUses = blocks.filter(
      (b) => (b as Record<string, unknown>).type === 'tool_use',
    );
    if (toolUses.length === 0) return;

    // Partition into read-only (parallelisable) and write (sequential).
    const readUses: typeof toolUses = [];
    const writeUses: typeof toolUses = [];
    for (const block of toolUses) {
      const name = (block as Record<string, unknown>).name as string;
      if (isReadOnlyTool(name)) {
        readUses.push(block);
      } else {
        writeUses.push(block);
      }
    }

    // Map from tool_use_id → result block for reassembly in original order.
    const resultMap = new Map<string, ContentBlock>();

    const toResultBlock = (
      id: string,
      res: { content: string; is_error?: boolean },
    ): ContentBlock => {
      const rb: ContentBlock = {
        type: 'tool_result',
        tool_use_id: id,
        content: res.content,
      };
      if (res.is_error) (rb as Record<string, unknown>).is_error = true;
      return rb;
    };

    // Execute read-only tools concurrently. A thrown read → error
    // tool_result (never a missing block, so no tool_use is orphaned).
    await Promise.all(
      readUses.map(async (block) => {
        const b = block as Record<string, any>;
        try {
          const res = await this.toolExecutor(b.name, b.input, b.id);
          resultMap.set(b.id, toResultBlock(b.id, res));
        } catch (err) {
          resultMap.set(
            b.id,
            toResultBlock(b.id, {
              content: err instanceof Error ? err.message : 'tool execution failed',
              is_error: true,
            }),
          );
        }
      }),
    );

    // Execute write tools strictly sequentially (approval UIs must not overlap).
    for (const block of writeUses) {
      const b = block as Record<string, any>;
      const res = await this.toolExecutor(b.name, b.input, b.id);
      resultMap.set(b.id, toResultBlock(b.id, res));
    }

    // Reassemble in original tool_use order for determinism.
    const results: ContentBlock[] = toolUses.map((block) => {
      const id = (block as Record<string, unknown>).id as string;
      return resultMap.get(id)!;
    });

    // Citations path (Anthropic only): for every successful read_note
    // result, append a document block to the same user turn so
    // Anthropic's Citations API can ground the response to exact
    // character spans. The document block carries the note body; the
    // tool_result still carries the short path echo for tool bookkeeping.
    // document_index is 0-based across ALL document blocks in the turn.
    const citationsEnabled = this.citationsEnabledProvider?.() ?? false;
    if (citationsEnabled) {
      let docIdx = 0;
      for (const block of toolUses) {
        const b = block as Record<string, any>;
        if (b.name === 'read_note') {
          const path = typeof b.input?.path === 'string' ? b.input.path : null;
          const res = resultMap.get(b.id as string);
          const body = res && !(res as Record<string, unknown>).is_error
            ? (res as Record<string, unknown>).content as string
            : null;
          if (path && body) {
            const docBlock = buildDocumentBlock(path, body) as unknown as ContentBlock;
            results.push(docBlock);
            this.documentRegistry.set(docIdx, path);
            docIdx++;
          }
        }
      }
    }

    this.messages.push({ role: 'user', content: results });
    this.handlers.onUpdate();

    await this.dispatch();
  }
}
