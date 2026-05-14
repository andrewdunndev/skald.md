// scribian wire protocol.
//
// Phase 0 retains `echo` / `pong` / `echoed` for diagnostics.
// Phase 1 adds Anthropic-shaped chat passthrough.
//
// Type-loose by design: content blocks and tool definitions flow as
// opaque records so the protocol stays current as Anthropic adds
// features (citations, server tools, extended thinking) without us
// having to update this package every time.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type ContentBlock = Record<string, unknown>;
export type SystemBlock = Record<string, unknown>;
export type ToolDefinition = Record<string, unknown>;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ThinkingConfig {
  type: 'enabled';
  budget_tokens: number;
}

export interface ChatRequest {
  model: string;
  system?: string | SystemBlock[];
  messages: Message[];
  tools?: ToolDefinition[];
  max_tokens: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  thinking?: ThinkingConfig;
}

// Plugin → Worker
export type ClientMessage =
  | { type: 'echo'; id: string; text: string }
  | { type: 'ping' }
  | {
      type: 'chat';
      id: string;
      payload: ChatRequest;
      // Anthropic API key supplied by the plugin. If absent, the Worker
      // falls back to its own ANTHROPIC_API_KEY secret. Lives outside
      // payload so it never reaches the Anthropic request body.
      anthropic_api_key?: string;
    }
  | { type: 'cancel'; id: string };

// Worker → Plugin
export type ServerMessage =
  | { type: 'echoed'; id: string; text: string; received_at: number }
  | { type: 'pong' }
  | { type: 'chunk'; id: string; event: string; data: unknown }
  | { type: 'done'; id: string; stop_reason: string; usage: Usage }
  | { type: 'error'; id?: string; error: string; retryable?: boolean };
