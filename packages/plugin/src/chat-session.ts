import type {
  ChatRequest,
  ContentBlock,
  Message,
  ServerMessage,
  Usage,
} from '@scribian/protocol';
import { Transport } from './transport';

export interface InFlight {
  id: string;
  blocks: ContentBlock[];
  usage: Usage;
}

export interface ChatSessionHandlers {
  onUpdate: () => void;
  onError: (err: string) => void;
  onDone: (stopReason: string, usage: Usage) => void;
}

export class ChatSession {
  private readonly messages: Message[] = [];
  private inFlight: InFlight | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly modelProvider: () => string,
    private readonly systemProvider: () => Promise<string | undefined>,
    private readonly handlers: ChatSessionHandlers,
  ) {}

  async sendUserText(text: string): Promise<void> {
    if (this.inFlight) {
      this.handlers.onError('A response is already in flight.');
      return;
    }

    this.messages.push({ role: 'user', content: text });

    const id = crypto.randomUUID();
    this.inFlight = {
      id,
      blocks: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    this.handlers.onUpdate();

    const system = await this.systemProvider();

    const payload: ChatRequest = {
      model: this.modelProvider(),
      messages: this.messages,
      max_tokens: 4096,
    };
    if (system) payload.system = system;

    this.transport.send({ type: 'chat', id, payload });
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
      this.finalize(msg.stop_reason, msg.usage);
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

  reset(): void {
    this.messages.length = 0;
    this.inFlight = null;
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
    } else if (event === 'message_delta') {
      if (d.usage && this.inFlight) {
        this.inFlight.usage = { ...this.inFlight.usage, ...d.usage };
      }
    } else if (event === 'message_start') {
      if (d.message?.usage && this.inFlight) {
        this.inFlight.usage = { ...this.inFlight.usage, ...d.message.usage };
      }
    }

    this.handlers.onUpdate();
  }

  private finalize(stopReason: string, usage: Usage): void {
    if (!this.inFlight) return;
    this.messages.push({
      role: 'assistant',
      content: this.inFlight.blocks,
    });
    const finalUsage = { ...this.inFlight.usage, ...usage };
    this.inFlight = null;
    this.handlers.onDone(stopReason, finalUsage);
    this.handlers.onUpdate();
  }
}
