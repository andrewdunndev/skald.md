/**
 * OpenAI request-body rewriter.
 *
 * Translates an Anthropic-shaped ChatRequest into the body expected by
 * OpenAI's /chat/completions endpoint (and compatible self-hosted servers
 * such as vLLM, Ollama, and LM-Studio).
 *
 * This is a PURE function — no side effects, no I/O. Stream flags
 * (stream: true) are added by the transport layer, not here.
 *
 * Coverage:
 *   - model passthrough
 *   - max_tokens kept as-is (vLLM/Ollama/LM-Studio accept it; OpenAI
 *     deprecated it in favour of max_completion_tokens but still honours
 *     max_tokens on most endpoints — transport can remap if needed)
 *   - stop_sequences → stop
 *   - temperature passthrough
 *   - thinking / metadata / anthropic-only fields dropped
 *   - system (string | block[]) → leading {role:'system', content:string}
 *   - messages: text, image, tool_use, tool_result, thinking blocks
 *   - tools: Anthropic custom-tool shape → OpenAI function-tool shape;
 *     server tools (web_search_* / web_fetch_* / no input_schema) stripped
 */

import type { ChatRequest } from '@skald/protocol';
import type { DispatchContext } from './direct-transport';
import { makeOpenAiStreamTranslator } from './openai-stream';

// ── Types (local, narrow enough for translation only) ────────────────────────

interface OAISystemMessage {
  role: 'system';
  content: string;
}

interface OAIUserMessage {
  role: 'user';
  content: string | OAIContentPart[];
}

interface OAIAssistantMessage {
  role: 'assistant';
  content?: string;
  tool_calls?: OAIToolCall[];
}

interface OAIToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

type OAIMessage =
  | OAISystemMessage
  | OAIUserMessage
  | OAIAssistantMessage
  | OAIToolMessage;

interface OAIContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Block = Record<string, unknown>;

/** True for Anthropic server-tool entries (web_search_* / web_fetch_* / etc.)
 * that have no `input_schema` — i.e. not a custom tool the model can call. */
function isServerTool(t: Record<string, unknown>): boolean {
  return !('input_schema' in t);
}

/** Coerce a tool_result content value to a plain string.
 * - string → as-is
 * - text block array → join on '\n\n'
 * - anything else → JSON.stringify
 */
function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = (content as Block[]).map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      return JSON.stringify(b);
    });
    return parts.join('\n\n');
  }
  return JSON.stringify(content ?? '');
}

/** Convert Anthropic system (string | block[]) to a plain string.
 * Concatenates text blocks with '\n\n'; strips cache_control. */
function systemToString(system: ChatRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return (system as Block[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Translate an Anthropic-shaped ChatRequest into an OpenAI
 * /chat/completions request body.
 *
 * Stream flags are NOT included — add `{ stream: true }` in the transport.
 */
export function requestBodyForOpenAI(req: ChatRequest): Record<string, unknown> {
  const oaiMessages: OAIMessage[] = [];

  // 1. System prompt ──────────────────────────────────────────────────────────
  const systemText = systemToString(req.system);
  if (systemText.trim()) {
    oaiMessages.push({ role: 'system', content: systemText });
  }

  // 2. Messages ───────────────────────────────────────────────────────────────
  for (const msg of req.messages) {
    const blocks: Block[] =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : (msg.content as Block[]);

    if (msg.role === 'user') {
      // Separate tool_result blocks from regular content blocks.
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const contentBlocks = blocks.filter((b) => b.type !== 'tool_result');

      // Emit content blocks as a user message (if any).
      if (contentBlocks.length > 0) {
        const parts = blocksToContentParts(contentBlocks);
        oaiMessages.push({
          role: 'user',
          content: parts.length === 1 && parts[0].type === 'text'
            ? (parts[0].text ?? '')
            : parts,
        });
      }

      // Explode each tool_result into its own role:'tool' message.
      for (const tr of toolResults) {
        const toolCallId =
          typeof tr.tool_use_id === 'string' ? tr.tool_use_id : '';
        const content = toolResultContentToString(tr.content);
        oaiMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content,
        });
      }
    } else if (msg.role === 'assistant') {
      // Collect text blocks and tool_use blocks separately.
      const textParts: string[] = [];
      const toolCalls: OAIToolCall[] = [];

      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const id = typeof b.id === 'string' ? b.id : '';
          const name = typeof b.name === 'string' ? b.name : '';
          const input = b.input !== undefined ? b.input : {};
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              arguments: JSON.stringify(input),
            },
          });
        } else if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        }
        // thinking / redacted_thinking → drop (fall through)
      }

      // Guard: if the turn was all-thinking (no text, no tool calls), do not
      // push an assistant message with neither content nor tool_calls — some
      // OpenAI-compatible servers reject such a message shape.
      if (textParts.length === 0 && toolCalls.length === 0) {
        // Skip this assistant turn entirely (thinking-only turns have no
        // conversational content to replay).
        continue;
      }
      const assistantMsg: OAIAssistantMessage = { role: 'assistant' };
      if (textParts.length > 0) assistantMsg.content = textParts.join('');
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      oaiMessages.push(assistantMsg);
    }
  }

  // 3. Top-level params ───────────────────────────────────────────────────────
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: oaiMessages,
  };

  if (req.stop_sequences && req.stop_sequences.length > 0) {
    body.stop = req.stop_sequences;
  }

  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }

  // thinking, metadata, and other Anthropic-only fields are intentionally
  // excluded — OpenAI endpoints don't recognise them.

  // 4. Tools ──────────────────────────────────────────────────────────────────
  if (req.tools && req.tools.length > 0) {
    const customTools = (req.tools as Block[]).filter((t) => !isServerTool(t));
    if (customTools.length > 0) {
      const oaiTools: OAIFunctionTool[] = customTools.map((t) => ({
        type: 'function',
        function: {
          name: typeof t.name === 'string' ? t.name : '',
          ...(typeof t.description === 'string'
            ? { description: t.description }
            : {}),
          parameters: t.input_schema ?? {},
        },
      }));
      body.tools = oaiTools;
    }
  }

  return body;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Convert a flat list of non-tool_result Anthropic content blocks to
 * OpenAI content parts (text + image_url). Drops thinking and unknown
 * block types. */
function blocksToContentParts(blocks: Block[]): OAIContentPart[] {
  const parts: OAIContentPart[] = [];

  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      const src = b.source as Block | undefined;
      if (src?.type === 'base64') {
        const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/jpeg';
        const data = typeof src.data === 'string' ? src.data : '';
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      }
    }
    // thinking / redacted_thinking / document / unknown → drop
  }

  return parts;
}

/**
 * Build the dispatch context (url, headers, body, stream translator)
 * for an OpenAI-compatible endpoint. Extracted from the transport so
 * the OpenAI request-shaping stays in one module.
 *
 * The base URL is assumed already validated by the caller
 * (validateOpenAiBaseUrl) — it is only normalized here.
 */
export function buildOpenAiDispatch(
  apiKey: string,
  req: ChatRequest,
  openAiBaseUrl: string,
): DispatchContext {
  const baseUrl = openAiBaseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const translator = makeOpenAiStreamTranslator();
  return {
    url: `${baseUrl}/chat/completions`,
    headers,
    // requestBodyForOpenAI produces the OpenAI body; stream flags are added
    // by the fetch layer ({ ...requestBody, stream: true }).
    // stream_options is included here so include_usage comes back.
    requestBody: {
      ...requestBodyForOpenAI(req),
      stream_options: { include_usage: true },
    } as unknown as ChatRequest,
    translateEvent: (_event: string, data: unknown) => translator(data),
    passEventlessFrames: true,
  };
}
