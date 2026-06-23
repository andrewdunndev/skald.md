/**
 * DirectTransport: call Anthropic / OpenRouter directly from the plugin.
 * Uses native fetch with `anthropic-dangerous-direct-browser-access: true`.
 * echo/ping: synchronous. cancel: aborts via AbortController.
 * Timeouts: REQUEST_TIMEOUT_MS to first byte; STREAM_IDLE_TIMEOUT_MS per chunk.
 */
import type { ClientMessage, Provider, ServerMessage, Usage } from '@skald/protocol';
import type { SkaldTransport, TransportHandlers } from './transport-interface';
import { SSEParser } from './sse-parser';
import { applyAnthropicCaching } from './anthropic-caching';
import { providerCapabilities } from './provider-capabilities';
import { httpErrorMessage, NETWORK_ERROR_MESSAGE } from './direct-transport-errors';
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, composeSignal } from './transport-timeouts';
import { rewriteOpenRouterTools, translateOpenRouterEvent } from './openrouter-translate';
import { makeOpenAiStreamTranslator } from './openai-stream';
import { requestBodyForOpenAI } from './openai-translate';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/messages';
const OPENROUTER_REFERER = 'https://github.com/skald/skald';
const OPENROUTER_TITLE = 'skald';

/** Config threaded in by view.ts at construction time. */
export interface DirectTransportConfig {
  getAnthropicKey: () => string;
  getOpenRouterKey: () => string;
  /** OpenAI-compatible Bearer token (optional; base URL flows via ClientMessage). */
  getOpenAiKey?: () => string;
  /** Optional — defaults to false. */
  getThinkingEnabled?: () => boolean;
}

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

  private async runChat(msg: Extract<ClientMessage, { type: 'chat' }>): Promise<void> {
    const { id, payload, provider = 'anthropic' } = msg;
    const apiKey =
      provider === 'openrouter'
        ? (msg.openrouter_api_key?.trim() || this.config.getOpenRouterKey().trim())
        : provider === 'openai'
          ? (msg.openai_api_key?.trim() || this.config.getOpenAiKey?.().trim() || '')
          : (msg.anthropic_api_key?.trim() || this.config.getAnthropicKey().trim());

    // OpenAI endpoints may need no auth; only anthropic/openrouter require a key.
    if (!apiKey && provider !== 'openai') {
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
    const openAiBaseUrl = provider === 'openai' ? (msg.openai_base_url ?? '') : undefined;
    const { url, headers, requestBody, translateEvent, passEventlessFrames } = buildDispatch(
      provider,
      apiKey,
      payload,
      thinkingEnabled,
      openAiBaseUrl,
    );

    const ac = new AbortController();
    this.activeChats.set(id, ac);

    const fetchSignal = composeSignal(ac.signal, REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        signal: fetchSignal,
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
      console.warn(`[skald] HTTP ${resp.status} from ${provider}`);
      const { error, retryable } = httpErrorMessage(
        resp.status,
        resp.headers.get('retry-after'),
      );
      this.handlers.onMessage({ type: 'error', id, error, retryable });
      return;
    }

    if (!resp.body) {
      this.activeChats.delete(id);
      this.handlers.onMessage({
        type: 'error',
        id,
        error: 'Empty response from the provider — resend.',
        retryable: true,
      });
      return;
    }

    await this.pumpStream(id, provider, resp, translateEvent, passEventlessFrames, ac);
  }

  private async pumpStream(
    id: string,
    provider: Provider,
    resp: Response,
    translateEvent: TranslateEvent,
    passEventlessFrames: boolean,
    ac: AbortController,
  ): Promise<void> {
    // resp.body is guaranteed non-null by the caller (Fix 2 guard).
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEParser();
    let stopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };

    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimedOut = true; reader.cancel().catch(() => {}); }, STREAM_IDLE_TIMEOUT_MS);
    };
    const stopIdle = () => clearTimeout(idleTimer);
    resetIdle();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { stopIdle(); break; }
        resetIdle();
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const frame of frames) {
          // Anthropic/OpenRouter: skip frames with no SSE event name (keep-alives).
          // OpenAI: all frames must pass through — the event field is always empty.
          if (!frame.event && !passEventlessFrames) continue;
          const translated = translateEvent(frame.event, frame.data);
          for (const t of translated) {
            this.handlers.onMessage({
              type: 'chunk',
              id,
              event: t.event,
              data: t.data,
            } as ServerMessage);

            const d = t.data as Record<string, any> | null;
            if (t.event === 'message_start' && d?.message?.usage) {
              usage = { ...usage, ...d.message.usage };
            }
            if (t.event === 'message_delta') {
              if (d?.usage) usage = { ...usage, ...d.usage };
              if (d?.delta?.stop_reason) stopReason = d.delta.stop_reason;
            }
          }
        }
      }
      // Flush any partial buffer on clean stream end.
      for (const frame of parser.flush()) {
        if (!frame.event && !passEventlessFrames) continue;
        const translated = translateEvent(frame.event, frame.data);
        for (const t of translated) {
          this.handlers.onMessage({
            type: 'chunk',
            id,
            event: t.event,
            data: t.data,
          } as ServerMessage);
        }
      }
    } catch (err) {
      stopIdle();
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
      console.warn('[skald] stream error:', err);
      this.handlers.onMessage({
        type: 'error',
        id,
        error: NETWORK_ERROR_MESSAGE,
        retryable: true,
      });
      return;
    }

    this.activeChats.delete(id);
    if (idleTimedOut) {
      this.handlers.onMessage({
        type: 'error',
        id,
        error: NETWORK_ERROR_MESSAGE,
        retryable: true,
      });
      return;
    }
    this.handlers.onMessage({ type: 'done', id, stop_reason: stopReason, usage, provider });
  }
}

/**
 * Generalised translate signature: receives the SSE frame's event name
 * (may be empty string for OpenAI frames which carry no `event:` field)
 * and parsed data; returns zero or more synthetic Anthropic events.
 *
 * Anthropic/OpenRouter paths skip frames with no event name by returning [].
 * The OpenAI path processes every frame regardless of event name.
 */
type TranslateEvent = (event: string, data: unknown) => Array<{ event: string; data: unknown }>;

interface DispatchContext {
  url: string;
  headers: Record<string, string>;
  requestBody: import('@skald/protocol').ChatRequest;
  translateEvent: TranslateEvent;
  /** When true the pump sends all frames (including event-less ones) to
   *  translateEvent. When false (Anthropic/OpenRouter) frames without an
   *  event name are skipped before translation (preserving prior behaviour). */
  passEventlessFrames: boolean;
}

/** Budget for extended thinking (carved out of max_tokens). */
const THINKING_BUDGET_TOKENS = 8192;

function buildDispatch(
  provider: Provider,
  apiKey: string,
  req: import('@skald/protocol').ChatRequest,
  thinkingEnabled: boolean,
  openAiBaseUrl?: string,
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
      translateEvent: wrapSingle(translateOpenRouterEvent),
      passEventlessFrames: false,
    };
  }
  if (provider === 'openai') {
    const baseUrl = (openAiBaseUrl ?? '').replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const translator = makeOpenAiStreamTranslator();
    return {
      url,
      headers,
      // requestBodyForOpenAI produces the OpenAI body; stream flags are added
      // by the fetch layer ({ ...requestBody, stream: true }).
      // stream_options is included here so include_usage comes back.
      requestBody: {
        ...requestBodyForOpenAI(req),
        stream_options: { include_usage: true },
      } as unknown as import('@skald/protocol').ChatRequest,
      translateEvent: (_event: string, data: unknown) => translator(data),
      passEventlessFrames: true,
    };
  }
  const caps = providerCapabilities(provider);
  const cachedReq = caps.promptCaching ? applyAnthropicCaching(req) : req;
  // Thinking: Anthropic requires max_tokens > budget_tokens; bump to budget+4096.
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
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    requestBody: requestBody as import('@skald/protocol').ChatRequest,
    translateEvent: wrapSingle(identityEvent),
    passEventlessFrames: false,
  };
}

/** Wrap a single-event translator to satisfy the array-returning TranslateEvent contract. */
function wrapSingle(
  fn: (event: string, data: unknown) => { event: string; data: unknown },
): TranslateEvent {
  return (event, data) => [fn(event, data)];
}

function identityEvent(event: string, data: unknown): { event: string; data: unknown } {
  return { event, data };
}
