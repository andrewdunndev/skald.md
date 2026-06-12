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
import type { ScribianTransport } from './transport-interface';

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

  /** Cumulative usage across every finalized turn in this
   * conversation. Reset when reset() is called (new chat). */
  getTotalUsage(): Usage {
    return this.totalUsage;
  }

  reset(): void {
    this.messages.length = 0;
    this.inFlight = null;
    this.totalUsage = { input_tokens: 0, output_tokens: 0 };
    this.conversationId = crypto.randomUUID();
    this.conversationCreated = new Date().toISOString();
    this.handlers.onUpdate();
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
      messages: this.messages,
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

    const results: ContentBlock[] = [];
    for (const block of toolUses) {
      const b = block as Record<string, any>;
      const result = await this.toolExecutor(b.name, b.input, b.id);
      const resultBlock: ContentBlock = {
        type: 'tool_result',
        tool_use_id: b.id,
        content: result.content,
      };
      if (result.is_error) {
        (resultBlock as Record<string, unknown>).is_error = true;
      }
      results.push(resultBlock);
    }

    this.messages.push({ role: 'user', content: results });
    this.handlers.onUpdate();

    await this.dispatch();
  }
}
