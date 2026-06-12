// scribian wire protocol.
//
// Phase 0 retains `echo` / `pong` / `echoed` for diagnostics.
// Phase 1 adds Anthropic-shaped chat passthrough.
// Phase 5 adds provider routing for OpenRouter fallback.
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
  // OpenRouter-only: per-server-tool counters under
  // usage.server_tool_use.{web_search_requests, web_fetch_requests}.
  // Anthropic native server tools count as part of input/output
  // tokens, no separate metering. Phase 12 (cost surfacing) reads
  // this for OpenRouter routes.
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
 * Provider routing. Anthropic is the default (rich content blocks,
 * native server tools, prompt caching). OpenRouter is the opt-in
 * fallback for the long tail of non-Anthropic models, accessed via
 * OpenRouter's Anthropic-shaped /api/v1/messages endpoint so the
 * Worker request body is unchanged across providers.
 */
export type Provider = 'anthropic' | 'openrouter';

// Plugin → Worker
export type ClientMessage =
  | { type: 'echo'; id: string; text: string }
  | { type: 'ping' }
  | {
      type: 'chat';
      id: string;
      payload: ChatRequest;
      // Provider routing decision. Lives at the ClientMessage level
      // (not inside payload) so it doesn't leak into the upstream
      // request body. Defaults to 'anthropic' for backward
      // compatibility with older plugin clients.
      provider?: Provider;
      // Per-provider keys supplied by the plugin. Worker falls back
      // to its own ANTHROPIC_API_KEY / OPENROUTER_API_KEY secrets if
      // absent. Lives outside payload so the API key never reaches
      // the upstream request body.
      anthropic_api_key?: string;
      openrouter_api_key?: string;
    }
  | { type: 'cancel'; id: string };

// Worker → Plugin
export type ServerMessage =
  | { type: 'echoed'; id: string; text: string; received_at: number }
  | { type: 'pong' }
  | { type: 'chunk'; id: string; event: string; data: unknown }
  | {
      type: 'done';
      id: string;
      stop_reason: string;
      usage: Usage;
      // Which provider served this turn. Surfaced so the plugin can
      // audit-log it and show provider in cost surfacing. Optional
      // for backward compatibility with older Workers.
      provider?: Provider;
    }
  | { type: 'error'; id?: string; error: string; retryable?: boolean };
