import type {
  ClientMessage,
  Provider,
  ServerMessage,
} from '@scribian/protocol';
import { TokenRegistry } from './auth';
import { renderAdminPage } from './admin';
import type { AuditEvent } from './session-state';
import { resolveProviderKey } from './providers';
import type { Env } from './env';
import { handleAdminRoute } from './routes/admin';
import { handleCaptureRoute } from './routes/capture';
import { handleIndexRoute } from './routes/index';
import { handleSearchRoute } from './routes/search';
import { handleMcpRoute, handleMcpRpc, type McpContext } from './routes/mcp';
import { handleChatRoute, runChat } from './routes/chat';

export type { Env } from './env';

const MAX_RECENT_EVENTS = 50;

// Single-vault DO name. All authenticated tokens reach this DO so the
// MCP bridge can find the plugin's WS. Multi-vault would need to derive
// this from a vault identifier on the token record (future work).
const SESSION_DO_NAME = 'scribian-default';

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
        mcp: '/mcp',
        admin: '/admin',
      });
    }

    if (url.pathname === '/admin') {
      return handleAdminRoute(req, env, registry, SESSION_DO_NAME);
    }

    if (!registry.hasAny()) {
      return new Response(
        'server misconfigured: set SCRIBIAN_TOKENS (preferred) or SCRIBIAN_TOKEN',
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

    if (url.pathname === '/mcp') {
      return handleMcpRoute(req, env, registry, SESSION_DO_NAME);
    }

    return handleChatRoute(req, env, registry, SESSION_DO_NAME);
  },
};

export class ScribianSession {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly activeChats: Map<string, AbortController> = new Map();
  private readonly pendingMcp: Map<
    string,
    (result: { content: string; is_error?: boolean }) => void
  > = new Map();
  private readonly recentEvents: AuditEvent[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
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
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/mcp') {
      const callerLabel = req.headers.get('x-scribian-caller-label') ?? 'unknown';
      return handleMcpRpc(req, callerLabel, this.mcpContext());
    }

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

  private mcpContext(): McpContext {
    return {
      sockets: () => this.state.getWebSockets(),
      pendingMcp: this.pendingMcp,
      send: (ws, msg) => this.send(ws, msg),
      record: (method, callerLabel) => this.record('mcp', callerLabel, method),
    };
  }

  private handleAdmin(req: Request): Response {
    const tokenSummaries = safeParseHeader<
      Array<{ label: string; scopes: string[] }>
    >(req.headers.get('x-scribian-admin-token-summaries'), []);
    const envSnap = safeParseHeader<{
      anthropic?: boolean;
      openrouter?: boolean;
      aigw?: boolean;
    }>(req.headers.get('x-scribian-admin-env-snapshot'), {});
    const html = renderAdminPage({
      version: 7,
      workerName: 'scribian',
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

    if (msg.type === 'mcp_result') {
      const cb = this.pendingMcp.get(msg.id);
      if (cb) {
        this.pendingMcp.delete(msg.id);
        cb({ content: msg.content, is_error: msg.is_error });
      }
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
