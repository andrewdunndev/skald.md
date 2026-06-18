/**
 * DirectTransport: call Anthropic / OpenRouter directly from the plugin,
 * bypassing the Cloudflare Worker entirely.
 *
 * Uses native fetch with the `anthropic-dangerous-direct-browser-access:
 * true` header (required by Anthropic to permit browser-origin requests).
 * Never uses Obsidian's requestUrl — that goes through Electron's server-
 * side fetch path which does NOT set the Origin header that the header
 * above guards against. Native fetch is correct here.
 *
 * Provider dispatch mirrors the Worker's packages/worker/src/providers/
 * logic: Anthropic is the default; OpenRouter is the opt-in fallback.
 * The translation helpers are intentionally duplicated rather than shared
 * to keep the worker package out of the plugin bundle — the protocol
 * package is the only shared dependency.
 *
 * echo/ping: handled synchronously (echoed/pong) — no network round-trip.
 * cancel: aborts the in-flight fetch via AbortController.
 */
import type { ClientMessage, Provider, ServerMessage, Usage } from '@scribian/protocol';
import type { ScribianTransport, TransportHandlers } from './transport-interface';
import { SSEParser } from './sse-parser';
import { applyAnthropicCaching } from './anthropic-caching';

// ── Anthropic ─────────────────────────────────────────────────────────────
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Anthropic-native server tool type identifiers (same set as the worker).
const ANTHROPIC_WEB_SEARCH_TYPES = ['web_search_20260209', 'web_search_20250305'];
const ANTHROPIC_WEB_FETCH_TYPES = ['web_fetch_20260209', 'web_fetch_20250910'];

// ── OpenRouter ────────────────────────────────────────────────────────────
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/messages';
const OPENROUTER_REFERER = 'https://github.com/scribian/scribian';
const OPENROUTER_TITLE = 'scribian';

const OR_WEB_SEARCH = 'openrouter:web_search';
const OR_WEB_FETCH = 'openrouter:web_fetch';

// ── ProviderKey resolver ──────────────────────────────────────────────────

/** Config threaded in by view.ts at construction time. */
export interface DirectTransportConfig {
  /** Returns the current Anthropic API key from settings. */
  getAnthropicKey: () => string;
  /** Returns the current OpenRouter API key from settings. */
  getOpenRouterKey: () => string;
}

// ── DirectTransport ───────────────────────────────────────────────────────

export class DirectTransport implements ScribianTransport {
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
        error: `No ${which} API key configured — add it in Settings → Scribian.`,
        retryable: false,
      });
      return;
    }

    const { url, headers, requestBody, translateEvent } = buildDispatch(
      provider,
      apiKey,
      payload,
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
        console.warn('[scribian] network error:', err);
        this.handlers.onMessage({
          type: 'error',
          id,
          error: 'Lost the connection — check your network and resend.',
          retryable: true,
        });
      }
      return;
    }

    if (!resp.ok) {
      this.activeChats.delete(id);
      if (resp.status === 429) {
        const retryAfter = resp.headers.get('retry-after');
        const retryHint = retryAfter
          ? ` (retry in ${retryAfter}s)`
          : '';
        this.handlers.onMessage({
          type: 'error',
          id,
          error: `Rate limit reached — wait a moment and resend.${retryHint}`,
          retryable: true,
        });
        return;
      }
      if (resp.status === 401 || resp.status === 403) {
        this.handlers.onMessage({
          type: 'error',
          id,
          error: 'Your API key was rejected — check it in Settings → Scribian.',
          retryable: false,
        });
        return;
      }
      if (resp.status === 400) {
        this.handlers.onMessage({
          type: 'error',
          id,
          error: "Claude couldn't process that request. If it keeps happening, try a new chat.",
          retryable: false,
        });
        return;
      }
      if (resp.status >= 500) {
        this.handlers.onMessage({
          type: 'error',
          id,
          error: "Claude's having a moment on its end — try again in a sec.",
          retryable: true,
        });
        return;
      }
      // Catch-all for any other unexpected status — log for debug, show clean copy.
      console.warn(`[scribian] unexpected HTTP ${resp.status} from ${provider}`);
      this.handlers.onMessage({
        type: 'error',
        id,
        error: `Something went wrong (error ${resp.status}) — try again or check your settings.`,
        retryable: false,
      });
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
      console.warn('[scribian] stream error:', err);
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
  requestBody: import('@scribian/protocol').ChatRequest;
  translateEvent: TranslateEvent;
}

function buildDispatch(
  provider: Provider,
  apiKey: string,
  req: import('@scribian/protocol').ChatRequest,
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
  return {
    url: ANTHROPIC_URL,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    requestBody: applyAnthropicCaching(req),
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
  req: import('@scribian/protocol').ChatRequest,
): import('@scribian/protocol').ChatRequest {
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
