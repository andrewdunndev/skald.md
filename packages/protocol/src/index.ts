// skald wire protocol.
//
// Phase 1 adds Anthropic-shaped chat passthrough.
// Phase 5 adds provider routing for OpenRouter fallback.
// Phase 8b: shared capture constants (prompt templates + response
//   parsing) hoisted here so all plugin paths share a single source
//   of truth. Duplication-drift is unacceptable.
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
 * request body is unchanged across providers.
 */
export type Provider = 'anthropic' | 'openrouter' | 'openai';

// Plugin → transport
export type ClientMessage =
  | {
      type: 'chat';
      id: string;
      payload: ChatRequest;
      // Provider routing decision. Lives at the ClientMessage level
      // (not inside payload) so it doesn't leak into the upstream
      // request body. Defaults to 'anthropic' for backward
      // compatibility.
      provider?: Provider;
      // Per-provider keys supplied by the plugin, sent directly to
      // the upstream API. Lives outside payload so the API key never
      // reaches the upstream request body.
      anthropic_api_key?: string;
      openrouter_api_key?: string;
      openai_api_key?: string;
      // OpenAI-compatible base URL (e.g. https://your-endpoint.example/v1 or http://localhost:11434/v1).
      // Lives outside payload alongside the keys.
      openai_base_url?: string;
    }
  | { type: 'cancel'; id: string };

// ── Capture shared constants ─────────────────────────────────────────────

/** Max bytes for a capture prompt. Enforced on the direct plugin path
 * so the plugin can't be tricked into a runaway upstream LLM spend.
 * 100 KB is generous for "shared from Safari Reader" content while
 * bounding a malicious payload. */
export const CAPTURE_MAX_PROMPT_BYTES = 100 * 1024;

/** Per-kind default prompt text for capture. Centralised here so all
 * plugin paths use the same prompts — changing the prompt in one place
 * changes it everywhere. */
export const CAPTURE_DEFAULT_PROMPTS: Record<string, string> = {
  url: 'The user shared this URL from their phone. Open it (or use what you know about it) and write a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, list any action items, suggest tags (Obsidian #tag format).',
  text: 'The user shared this text from their phone. Process it into a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, suggest tags.',
  image:
    'The user shared this image from their phone (you have access to it as an image attachment). Describe what is shown, transcribe any visible text, and write a vault-ready capture note: title (≤8 words), description, any extracted text, suggested tags.',
  pdf: 'The user shared this PDF from their phone. Process it into a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, identify any action items, suggest tags.',
};

/** Extract the title from a model-generated capture body.
 * Contract: first H1 if present, else first non-empty line,
 * capped at 60 chars. Centralised here as the single parsing rule
 * for all plugin capture paths. */
export function extractCaptureTitle(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const titleMatch = firstLine.match(/^#+\s+(.*)$/);
  return (titleMatch?.[1] ?? firstLine).slice(0, 60).trim();
}

// Transport → Plugin
export type ServerMessage =
  | { type: 'chunk'; id: string; event: string; data: unknown }
  | {
      type: 'done';
      id: string;
      stop_reason: string;
      usage: Usage;
      // Which provider served this turn. Surfaced so the plugin can
      // audit-log it and show provider in cost surfacing.
      provider?: Provider;
    }
  | { type: 'error'; id?: string; error: string; retryable?: boolean };
