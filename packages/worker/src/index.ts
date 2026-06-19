import type {
  ClientMessage,
  Provider,
  ServerMessage,
} from '@skald/protocol';
import { TokenRegistry } from './auth';
import { renderAdminPage } from './admin';
import type { AuditEvent } from './session-state';
import { resolveProviderKey } from './providers';
import type { Env } from './env';
import { handleAdminRoute } from './routes/admin';
import { handleCaptureRoute } from './routes/capture';
import { handleIndexRoute } from './routes/index';
import { handleSearchRoute } from './routes/search';
import { handleChatRoute, runChat } from './routes/chat';

export type { Env } from './env';

const MAX_RECENT_EVENTS = 50;

// Single-vault DO name.
const SESSION_DO_NAME = 'skald-default';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const registry = new TokenRegistry(env);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        anthropic_key_present: !!env.ANTHROPIC_API_KEY,
        openrouter_key_present: !!env.OPENROUTER_API_KEY,
        ai_gateway: !!env.AI_GATEWAY_URL,
        tokens_configured: registry.hasAny(),
        version: 7,
        admin: '/admin',
      });
    }

    if (url.pathname === '/admin') {
      return handleAdminRoute(req, env, registry, SESSION_DO_NAME);
    }

    if (!registry.hasAny()) {
      return new Response(
        'server misconfigured: set SKALD_TOKENS (preferred) or SKALD_TOKEN',
        { status: 500 },
      );
    }

    if (url.pathname === '/capture') {
      return handleCaptureRoute(req, env, registry);
    }

    if (url.pathname === '/index') {
      return handleIndexRoute(req, env, registry);
    }

    if (url.pathname === '/search') {
      return handleSearchRoute(req, env, registry);
    }

    return handleChatRoute(req, env, registry, SESSION_DO_NAME);
  },
};

const AUDIT_STORAGE_KEY = 'recentEvents';

/** WS message size cap. Chat messages with attached note context
 * + multi-modal payloads can be large; 1 MB is generous for a real
 * turn (an attached note + a base64-encoded image hits roughly
 * 700KB at the 5MB-pre-encoding image cap). Above this, the message
 * is rejected with an error before JSON.parse — bounds memory
 * pressure on the DO from a misbehaving (or compromised) client. */
const WS_MAX_MESSAGE_BYTES = 1024 * 1024;

export class SkaldSession {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly activeChats: Map<string, AbortController> = new Map();
  private recentEvents: AuditEvent[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Block input until we've restored the audit ring buffer from
    // storage. Without this, events recorded between cold-start and
    // first read would silently miss prior history. blockConcurrencyWhile
    // is DO's idiomatic "initialize before any request lands" hook.
    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<AuditEvent[]>(
        AUDIT_STORAGE_KEY,
      );
      if (Array.isArray(stored)) this.recentEvents = stored;
    });
  }

  private record(
    type: AuditEvent['type'],
    label: string,
    detail: string,
    provider?: Provider,
  ): void {
    this.recentEvents.push({ ts: Date.now(), type, label, detail, provider });
    while (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.shift();
    }
    // Persist asynchronously. We don't await — losing the most
    // recent event on a crash is acceptable; blocking every audit
    // event behind a storage write isn't. DO storage writes are
    // fire-and-forget durable on the same DO.
    void this.state.storage.put(AUDIT_STORAGE_KEY, this.recentEvents);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/admin') {
      return this.handleAdmin(req);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);

    const echoed =
      req.headers.get('Sec-WebSocket-Protocol')?.split(',')[0]?.trim() ?? '';
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': echoed },
    });
  }

  private handleAdmin(req: Request): Response {
    const tokenSummaries = safeParseHeader<
      Array<{ label: string; scopes: string[] }>
    >(req.headers.get('x-skald-admin-token-summaries'), []);
    const envSnap = safeParseHeader<{
      anthropic?: boolean;
      openrouter?: boolean;
      aigw?: boolean;
    }>(req.headers.get('x-skald-admin-env-snapshot'), {});
    const html = renderAdminPage({
      version: 7,
      workerName: 'skald',
      anthropicKeyPresent: !!envSnap.anthropic,
      openrouterKeyPresent: !!envSnap.openrouter,
      aiGatewayConfigured: !!envSnap.aigw,
      tokenSummaries,
      connectedWebSockets: this.state.getWebSockets().length,
      recentEvents: this.recentEvents,
    });
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Don't let the page get cached — the recent-events list and
        // connection count are live.
        'cache-control': 'no-store',
      },
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Size cap before parse: a 50MB JSON string would crash JSON.parse
    // (and burn DO memory) before any validation runs.
    const messageBytes =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (messageBytes > WS_MAX_MESSAGE_BYTES) {
      this.send(ws, {
        type: 'error',
        error: `message exceeds ${WS_MAX_MESSAGE_BYTES}-byte cap`,
      });
      return;
    }

    let msg: ClientMessage;
    try {
      const raw =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(message);
      msg = JSON.parse(raw) as ClientMessage;
    } catch (err) {
      this.send(ws, {
        type: 'error',
        error: err instanceof Error ? err.message : 'parse error',
      });
      return;
    }

    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'echo') {
      this.send(ws, {
        type: 'echoed',
        id: msg.id,
        text: msg.text,
        received_at: Date.now(),
      });
      return;
    }

    if (msg.type === 'cancel') {
      this.activeChats.get(msg.id)?.abort();
      this.activeChats.delete(msg.id);
      return;
    }

    if (msg.type === 'chat') {
      const provider: Provider = msg.provider ?? 'anthropic';
      const apiKey = resolveProviderKey(provider, this.env, {
        anthropic_api_key: msg.anthropic_api_key,
        openrouter_api_key: msg.openrouter_api_key,
      });
      this.record(
        'chat',
        'plugin',
        `model=${msg.payload.model} msgs=${msg.payload.messages.length}`,
        provider,
      );
      await runChat(ws, this.env, provider, apiKey, msg.id, msg.payload, {
        activeChats: this.activeChats,
        send: (s, m) => this.send(s, m),
      });
      return;
    }

    this.send(ws, { type: 'error', error: 'unknown message type' });
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    for (const ac of this.activeChats.values()) ac.abort();
    this.activeChats.clear();
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket closed mid-stream
    }
  }
}

function safeParseHeader<T>(header: string | null, fallback: T): T {
  if (!header) return fallback;
  try {
    return JSON.parse(header) as T;
  } catch {
    return fallback;
  }
}
