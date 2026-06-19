/**
 * DirectTransport: call Anthropic / OpenRouter directly from the plugin,
 * bypassing the Cloudflare Worker entirely. Uses native fetch with the
 * `anthropic-dangerous-direct-browser-access: true` header. Never uses
 * Obsidian's requestUrl — that path doesn't set the required Origin header.
 *
 * Provider dispatch: Anthropic is the default; OpenRouter is the opt-in
 * fallback. Translation helpers are intentionally duplicated (not shared)
 * to keep the worker package out of the plugin bundle.
 *
 * echo/ping: synchronous. cancel: aborts via AbortController.
 */
import type { ClientMessage, Provider, ServerMessage, Usage } from '@skald/protocol';
import type { SkaldTransport, TransportHandlers } from './transport-interface';
import { SSEParser } from './sse-parser';
import { applyAnthropicCaching } from './anthropic-caching';
import { providerCapabilities } from './provider-capabilities';
import { httpErrorMessage, NETWORK_ERROR_MESSAGE } from './direct-transport-errors';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_WEB_SEARCH_TYPES = ['web_search_20260209', 'web_search_20250305'];
const ANTHROPIC_WEB_FETCH_TYPES = ['web_fetch_20260209', 'web_fetch_20250910'];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/messages';
const OPENROUTER_REFERER = 'https://github.com/skald/skald';
const OPENROUTER_TITLE = 'skald';
const OR_WEB_SEARCH = 'openrouter:web_search';
const OR_WEB_FETCH = 'openrouter:web_fetch';

/** Config threaded in by view.ts at construction time. */
export interface DirectTransportConfig {
  /** Returns the current Anthropic API key from settings. */
  getAnthropicKey: () => string;
  /** Returns the current OpenRouter API key from settings. */
  getOpenRouterKey: () => string;
  /** Optional — defaults to false. Extended thinking ("deep mode"). TODO(wiring):
   * pass `() => plugin.settings.thinkingEnabled` from view/connect-session.ts ~L92. */
  getThinkingEnabled?: () => boolean;
}

// ── DirectTransport ───────────────────────────────────────────────────────

export class DirectTransport implements SkaldTransport {
  /** One AbortController per in-flight chat turn, keyed by turn id. */
  private readonly activeChats = new Map<string, AbortController>();
  private connected = false;

  constructor(
    private readonly config: DirectTransportConfig,
    private readonly handlers: TransportHandlers,
  ) {}

  connect(): void {
    this.connected = true;
    // Fire immediately — no async handshake needed.
    this.handlers.onOpen();
  }

  isOpen(): boolean {
    return this.connected;
  }

  close(): void {
    this.connected = false;
    // Abort any in-flight chats so pending Promises don't dangle.
    for (const ac of this.activeChats.values()) {
      ac.abort();
    }
    this.activeChats.clear();
    this.handlers.onClose(1000, 'closed');
  }

  send(msg: ClientMessage): void {
    switch (msg.type) {
      case 'echo':
        this.handlers.onMessage({
          type: 'echoed',
          id: msg.id,
          text: msg.text,
          received_at: Date.now(),
        });
        return;
      case 'ping':
        this.handlers.onMessage({ type: 'pong' });
        return;
      case 'cancel': {
        const ac = this.activeChats.get(msg.id);
        if (ac) ac.abort();
        return;
      }
      case 'chat':
        void this.runChat(msg);
        return;
    }
  }

  // ── Chat dispatch ───────────────────────────────────────────────────────

  private async runChat(msg: Extract<ClientMessage, { type: 'chat' }>): Promise<void> {
    const { id, payload, provider = 'anthropic' } = msg;

    // Resolve which API key to use: per-turn key from the message wins;
    // fall back to the setting value.
    const apiKey =
      provider === 'openrouter'
        ? (msg.openrouter_api_key?.trim() || this.config.getOpenRouterKey().trim())
        : (msg.anthropic_api_key?.trim() || this.config.getAnthropicKey().trim());

    if (!apiKey) {
      const which = provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
      this.handlers.onMessage({
        type: 'error',
        id,
        error: `No ${which} API key configured — add it in Settings → Skald.`,
        retryable: false,
      });
      return;
    }

    const thinkingEnabled = this.config.getThinkingEnabled?.() ?? false;
    const { url, headers, requestBody, translateEvent } = buildDispatch(
      provider,
      apiKey,
      payload,
      thinkingEnabled,
    );

    const ac = new AbortController();
    this.activeChats.set(id, ac);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers,
        body: JSON.stringify({ ...requestBody, stream: true }),
      });
    } catch (err) {
      this.activeChats.delete(id);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        this.handlers.onMessage({
          type: 'done',
          id,
          stop_reason: 'cancelled',
          usage: { input_tokens: 0, output_tokens: 0 },
          provider,
        });
      } else {
        // Log the raw error for debugging; surface only a human sentence.
        console.warn('[skald] network error:', err);
        this.handlers.onMessage({
          type: 'error',
          id,
          error: NETWORK_ERROR_MESSAGE,
          retryable: true,
        });
      }
      return;
    }

    if (!resp.ok) {
      this.activeChats.delete(id);
      // Log raw status for debugging; surface only a human sentence.
      console.warn(`[skald] HTTP ${resp.status} from ${provider}`);
      const { error, retryable } = httpErrorMessage(
        resp.status,
        resp.headers.get('retry-after'),
      );
      this.handlers.onMessage({ type: 'error', id, error, retryable });
      return;
    }

    await this.pumpStream(id, provider, resp, translateEvent, ac);
  }

  private async pumpStream(
    id: string,
    provider: Provider,
    resp: Response,
    translateEvent: TranslateEvent,
    ac: AbortController,
  ): Promise<void> {
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let stopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const frame of frames) {
          if (!frame.event) continue;
          const translated = translateEvent(frame.event, frame.data);
          this.handlers.onMessage({
            type: 'chunk',
            id,
            event: translated.event,
            data: translated.data,
          } as ServerMessage);

          const d = translated.data as Record<string, any> | null;
          if (translated.event === 'message_start' && d?.message?.usage) {
            usage = { ...usage, ...d.message.usage };
          }
          if (translated.event === 'message_delta') {
            if (d?.usage) usage = { ...usage, ...d.usage };
            if (d?.delta?.stop_reason) stopReason = d.delta.stop_reason;
          }
        }
      }
      // Flush any partial buffer on clean stream end.
      for (const frame of parser.flush()) {
        if (frame.event) {
          const translated = translateEvent(frame.event, frame.data);
          this.handlers.onMessage({
            type: 'chunk',
            id,
            event: translated.event,
            data: translated.data,
          } as ServerMessage);
        }
      }
    } catch (err) {
      this.activeChats.delete(id);
      if (err instanceof Error && err.name === 'AbortError') {
        this.handlers.onMessage({
          type: 'done',
          id,
          stop_reason: 'cancelled',
          usage,
          provider,
        });
        return;
      }
      // Log raw error for debugging; surface only a human sentence.
      console.warn('[skald] stream error:', err);
      this.handlers.onMessage({
        type: 'error',
        id,
        error: 'Lost the connection mid-response — check your network and resend.',
        retryable: true,
      });
      return;
    }

    this.activeChats.delete(id);
    this.handlers.onMessage({ type: 'done', id, stop_reason: stopReason, usage, provider });
  }
}

// ── Provider dispatch helpers ────────────────────────────────────────────

type TranslateEvent = (
  event: string,
  data: unknown,
) => { event: string; data: unknown };

interface DispatchContext {
  url: string;
  headers: Record<string, string>;
  requestBody: import('@skald/protocol').ChatRequest;
  translateEvent: TranslateEvent;
}

/** Budget for extended thinking. Anthropic includes thinking tokens in
 * output_tokens, so pricing.ts output accounting already covers them. */
const THINKING_BUDGET_TOKENS = 8192;

function buildDispatch(
  provider: Provider,
  apiKey: string,
  req: import('@skald/protocol').ChatRequest,
  thinkingEnabled: boolean,
): DispatchContext {
  if (provider === 'openrouter') {
    return {
      url: OPENROUTER_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': OPENROUTER_REFERER,
        'X-OpenRouter-Title': OPENROUTER_TITLE,
      },
      requestBody: rewriteOpenRouterTools(req),
      translateEvent: translateOpenRouterEvent,
    };
  }
  // Anthropic (default)
  const caps = providerCapabilities(provider);
  const cachedReq = caps.promptCaching ? applyAnthropicCaching(req) : req;

  // Attach extended thinking when on + supported (OpenRouter guarded above).
  // Anthropic requires max_tokens > budget_tokens (budget is carved OUT of
  // max_tokens); the 4096 dispatch default < the 8192 budget → 400. Bump
  // max_tokens here (single attach point), keeping 4096 output headroom.
  const requestBody =
    thinkingEnabled && caps.extendedThinking
      ? {
          ...cachedReq,
          max_tokens: Math.max(cachedReq.max_tokens ?? 4096, THINKING_BUDGET_TOKENS + 4096),
          thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
        }
      : cachedReq;

  return {
    url: ANTHROPIC_URL,
    headers: {
      // Prompt caching (incl. 1h TTL) is GA — no beta header (docs, 2026-06).
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    requestBody: requestBody as import('@skald/protocol').ChatRequest,
    translateEvent: identityEvent,
  };
}

function identityEvent(
  event: string,
  data: unknown,
): { event: string; data: unknown } {
  return { event, data };
}

// ── OpenRouter tool rewriting (mirrors worker/src/providers/openrouter.ts) ─

function rewriteOpenRouterTools(
  req: import('@skald/protocol').ChatRequest,
): import('@skald/protocol').ChatRequest {
  if (!req.tools) return req;
  const tools = req.tools.map((t) => {
    const type =
      typeof (t as Record<string, unknown>).type === 'string'
        ? ((t as Record<string, unknown>).type as string)
        : undefined;
    if (type && ANTHROPIC_WEB_SEARCH_TYPES.includes(type)) {
      return { type: OR_WEB_SEARCH };
    }
    if (type && ANTHROPIC_WEB_FETCH_TYPES.includes(type)) {
      return { type: OR_WEB_FETCH };
    }
    return t;
  });
  return { ...req, tools };
}

function translateOpenRouterEvent(
  event: string,
  data: unknown,
): { event: string; data: unknown } {
  if (!data || typeof data !== 'object') return { event, data };
  const obj = data as Record<string, unknown>;

  if (event === 'content_block_start') {
    const block = obj.content_block as Record<string, unknown> | undefined;
    if (block) {
      const translated = translateOpenRouterBlock(block);
      if (translated !== block) {
        return { event, data: { ...obj, content_block: translated } };
      }
    }
  }

  return { event, data };
}

function translateOpenRouterBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const blockType = typeof block.type === 'string' ? block.type : undefined;
  const blockName = typeof block.name === 'string' ? block.name : undefined;

  if (
    (blockType === 'tool_use' || blockType === 'server_tool_use') &&
    blockName
  ) {
    if (blockName === OR_WEB_SEARCH) {
      return { ...block, type: 'server_tool_use', name: 'web_search' };
    }
    if (blockName === OR_WEB_FETCH) {
      return { ...block, type: 'server_tool_use', name: 'web_fetch' };
    }
  }

  if (blockType === `${OR_WEB_SEARCH}_result`) {
    return { ...block, type: 'web_search_tool_result' };
  }
  if (blockType === `${OR_WEB_FETCH}_result`) {
    return { ...block, type: 'web_fetch_tool_result' };
  }

  return block;
}
