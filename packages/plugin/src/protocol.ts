// Shared wire types: Anthropic-shaped chat requests, the provider union, and
// the transport messages exchanged between the chat session and the transport.
//
// Content blocks and tool definitions flow as opaque records so the types stay
// current as providers add features without edits here.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // OpenRouter-only per-server-tool counters; Anthropic native server tools
  // count inside input/output tokens.
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
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

/**
 * Anthropic is the default (content blocks, native server tools, prompt
 * caching). OpenRouter and OpenAI-compatible endpoints are translated from the
 * same Anthropic-shaped request body.
 */
export type Provider = 'anthropic' | 'openrouter' | 'openai';

// Chat session -> transport
export type ClientMessage =
  | {
      type: 'chat';
      id: string;
      payload: ChatRequest;
      // Omitted means anthropic. Kept outside payload so it never reaches the
      // upstream request body.
      provider?: Provider;
      // OpenAI-compatible base URL; also kept outside payload.
      openai_base_url?: string;
    }
  | { type: 'cancel'; id: string };

// Transport -> chat session
export type ServerMessage =
  | { type: 'chunk'; id: string; event: string; data: unknown }
  | {
      type: 'done';
      id: string;
      stop_reason: string;
      usage: Usage;
      provider?: Provider;
    }
  | { type: 'error'; id?: string; error: string; retryable?: boolean };
