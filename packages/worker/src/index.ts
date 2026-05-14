import type {
  ChatRequest,
  ClientMessage,
  Provider,
  ServerMessage,
  Usage,
} from '@scribian/protocol';
import {
  MCP_TOOLS,
  rpcError,
  rpcResult,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  type JsonRpcRequest,
} from './mcp';
import { TokenRegistry, hasScope, type AuthResult } from './auth';
import { renderAdminPage } from './admin';
import type { AuditEvent } from './session-state';
import { dispatchFor, resolveProviderKey } from './providers';

const MAX_RECENT_EVENTS = 50;

export interface Env {
  SCRIBIAN_TOKEN?: string;
  SCRIBIAN_TOKENS?: string;
  /** Anthropic API key (default provider). Optional — Worker is valid
   * with only OPENROUTER_API_KEY set if every user supplies their own
   * Anthropic key in plugin settings. */
  ANTHROPIC_API_KEY?: string;
  /** OpenRouter API key (fallback provider for non-Anthropic models). */
  OPENROUTER_API_KEY?: string;
  SCRIBIAN_SESSION: DurableObjectNamespace;
  AI_GATEWAY_URL?: string;
}

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TOOL_TIMEOUT_MS = 8000;

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
      const auth = authBearerOrQuery(req, registry);
      if (!auth.ok) {
        return new Response(auth.reason, { status: auth.status });
      }
      if (!hasScope(auth.result.scopes, 'chat')) {
        return new Response('admin page requires chat scope', { status: 403 });
      }
      // Forward to the DO so we can pull connected-WS count and the
      // recent-events ring buffer. Build the view model in the DO.
      const stub = env.SCRIBIAN_SESSION.get(
        env.SCRIBIAN_SESSION.idFromName(SESSION_DO_NAME),
      );
      const fwd = new Request(req.url, {
        method: 'GET',
        headers: new Headers({
          'x-scribian-admin-token-summaries': JSON.stringify(
            registry.tokenSummaries(),
          ),
          'x-scribian-admin-env-snapshot': JSON.stringify({
            anthropic: !!env.ANTHROPIC_API_KEY,
            openrouter: !!env.OPENROUTER_API_KEY,
            aigw: !!env.AI_GATEWAY_URL,
          }),
        }),
      });
      return stub.fetch(fwd);
    }

    if (!registry.hasAny()) {
      return new Response(
        'server misconfigured: set SCRIBIAN_TOKENS (preferred) or SCRIBIAN_TOKEN',
        { status: 500 },
      );
    }

    // MCP endpoint — HTTP JSON-RPC.
    if (url.pathname === '/mcp') {
      const auth = authBearer(req, registry);
      if (!auth.ok) {
        console.log(`mcp auth failed: ${auth.reason}`);
        return new Response(auth.reason, { status: auth.status });
      }
      if (!hasScope(auth.result.scopes, 'mcp:read')) {
        console.log(
          `mcp scope denied: label=${auth.result.label} scopes=${auth.result.scopes.join(',')}`,
        );
        return new Response('token lacks mcp:read scope', { status: 403 });
      }
      const stub = env.SCRIBIAN_SESSION.get(
        env.SCRIBIAN_SESSION.idFromName(SESSION_DO_NAME),
      );
      // Pass caller label through a header so the DO can include it
      // when forwarding to the plugin.
      const fwd = new Request(req, { headers: new Headers(req.headers) });
      fwd.headers.set('x-scribian-caller-label', auth.result.label);
      return stub.fetch(fwd);
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const auth = authSubprotocol(req, registry);
    if (!auth.ok) {
      console.log(`ws auth failed: ${auth.reason}`);
      return new Response(auth.reason, { status: auth.status });
    }
    if (!hasScope(auth.result.scopes, 'chat')) {
      console.log(
        `ws scope denied: label=${auth.result.label} scopes=${auth.result.scopes.join(',')}`,
      );
      return new Response('token lacks chat scope', { status: 403 });
    }
    console.log(`ws auth ok: label=${auth.result.label}`);

    const stub = env.SCRIBIAN_SESSION.get(
      env.SCRIBIAN_SESSION.idFromName(SESSION_DO_NAME),
    );
    return stub.fetch(req);
  },
};

function authBearer(
  req: Request,
  registry: TokenRegistry,
): { ok: true; result: AuthResult } | { ok: false; reason: string; status: number } {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing bearer', status: 401 };
  }
  const candidate = header.slice(7).trim();
  const auth = registry.authenticate(candidate);
  if (!auth) {
    return { ok: false, reason: 'bad token', status: 401 };
  }
  return { ok: true, result: auth };
}

/**
 * Same as authBearer but also accepts ?token=... in the query string for
 * the diagnostic page so you can paste a one-line URL into a browser.
 * Query-string tokens land in browser history; bearer header is preferred.
 */
function authBearerOrQuery(
  req: Request,
  registry: TokenRegistry,
): { ok: true; result: AuthResult } | { ok: false; reason: string; status: number } {
  const bearer = authBearer(req, registry);
  if (bearer.ok) return bearer;
  const url = new URL(req.url);
  const candidate = url.searchParams.get('token')?.trim() ?? '';
  if (!candidate) return bearer; // surface the original 401
  const auth = registry.authenticate(candidate);
  if (!auth) return { ok: false, reason: 'bad token', status: 401 };
  return { ok: true, result: auth };
}

function authSubprotocol(
  req: Request,
  registry: TokenRegistry,
): { ok: true; result: AuthResult } | { ok: false; reason: string; status: number } {
  const rawProto = req.headers.get('Sec-WebSocket-Protocol') ?? '';
  if (!rawProto) {
    return { ok: false, reason: 'missing protocol', status: 401 };
  }
  const candidate = rawProto.split(',')[0]?.trim() ?? '';
  const auth = registry.authenticate(candidate);
  if (!auth) {
    return { ok: false, reason: 'bad token', status: 401 };
  }
  return { ok: true, result: auth };
}

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
      return this.handleMcp(req, callerLabel);
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
      await this.runChat(ws, provider, apiKey, msg.id, msg.payload);
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

  // ─── MCP server ─────────────────────────────────────────────────

  private async handleMcp(
    req: Request,
    callerLabel: string,
  ): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('method not allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(rpcError(null, PARSE_ERROR, 'invalid JSON'));
    }

    const requests = Array.isArray(body) ? body : [body];
    const responses: unknown[] = [];
    for (const r of requests) {
      const reply = await this.handleRpc(r as JsonRpcRequest, callerLabel);
      if (reply !== null) responses.push(reply);
    }

    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  }

  private async handleRpc(
    rpc: JsonRpcRequest,
    callerLabel: string,
  ): Promise<unknown | null> {
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return rpcError(rpc?.id ?? null, INVALID_REQUEST, 'invalid request');
    }
    const isNotification = rpc.id === undefined || rpc.id === null;

    console.log(`mcp call: label=${callerLabel} method=${rpc.method}`);
    this.record('mcp', callerLabel, rpc.method);

    try {
      switch (rpc.method) {
        case 'initialize':
          return rpcResult(rpc.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'scribian', version: '0.0.1' },
          });

        case 'notifications/initialized':
          return isNotification ? null : rpcResult(rpc.id, {});

        case 'tools/list':
          return rpcResult(rpc.id, { tools: MCP_TOOLS });

        case 'tools/call': {
          const params = (rpc.params ?? {}) as {
            name?: string;
            arguments?: unknown;
          };
          if (typeof params.name !== 'string') {
            return rpcError(rpc.id, INVALID_PARAMS, 'name is required');
          }
          // Defense in depth: read-only tokens (mcp:read) cannot invoke
          // write tools even if the plugin happens to be configured to
          // accept them. The plugin already auto-rejects writes on the
          // MCP path (handleMcpCall's approve callback returns false),
          // but rejecting at the Worker boundary saves a bridge round-
          // trip and keeps the audit log honest.
          if (isWriteToolName(params.name)) {
            return rpcError(
              rpc.id,
              -32603,
              `Tool '${params.name}' requires mcp:write scope; MCP clients are read-only.`,
            );
          }
          const result = await this.bridgeToolCall(
            params.name,
            params.arguments,
            callerLabel,
          );
          return rpcResult(rpc.id, {
            content: [{ type: 'text', text: result.content }],
            isError: result.is_error ?? false,
          });
        }

        case 'ping':
          return rpcResult(rpc.id, {});

        default:
          return isNotification
            ? null
            : rpcError(rpc.id, METHOD_NOT_FOUND, `unknown method: ${rpc.method}`);
      }
    } catch (err) {
      return rpcError(
        rpc.id,
        INTERNAL_ERROR,
        err instanceof Error ? err.message : 'internal error',
      );
    }
  }

  private async bridgeToolCall(
    name: string,
    input: unknown,
    callerLabel: string,
  ): Promise<{ content: string; is_error?: boolean }> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return {
        content:
          'No Obsidian plugin is currently connected — open the scribian chat pane to bring the vault online.',
        is_error: true,
      };
    }
    const callId = crypto.randomUUID();
    const promise = new Promise<{ content: string; is_error?: boolean }>(
      (resolve) => {
        this.pendingMcp.set(callId, resolve);
      },
    );
    const timeout = new Promise<{ content: string; is_error?: boolean }>(
      (resolve) =>
        setTimeout(() => {
          this.pendingMcp.delete(callId);
          resolve({
            content: `Plugin did not respond within ${MCP_TOOL_TIMEOUT_MS}ms.`,
            is_error: true,
          });
        }, MCP_TOOL_TIMEOUT_MS),
    );

    this.send(sockets[0], {
      type: 'mcp_call',
      id: callId,
      name,
      input,
      caller_label: callerLabel,
    });

    return Promise.race([promise, timeout]);
  }

  private async runChat(
    ws: WebSocket,
    provider: Provider,
    apiKey: string | undefined,
    id: string,
    req: ChatRequest,
  ): Promise<void> {
    if (!apiKey) {
      const which = provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
      const envName =
        provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
      this.send(ws, {
        type: 'error',
        id,
        error: `No ${which} API key. Set it in plugin settings (preferred) or on the Worker secret ${envName}.`,
        retryable: false,
      });
      return;
    }

    const dispatch = dispatchFor(provider, apiKey, this.env, req);
    const via =
      provider === 'anthropic' && this.env.AI_GATEWAY_URL
        ? 'aigw'
        : provider === 'anthropic'
          ? 'direct'
          : 'openrouter';

    console.log(
      `chat ${id} (${via}): model=${req.model} messages=${req.messages.length} tools=${req.tools?.length ?? 0} system=${!!req.system}`,
    );

    const ac = new AbortController();
    this.activeChats.set(id, ac);

    let resp: Response;
    try {
      resp = await fetch(dispatch.url, {
        method: 'POST',
        signal: ac.signal,
        headers: dispatch.headers,
        body: JSON.stringify({ ...dispatch.request, stream: true }),
      });
    } catch (err) {
      this.activeChats.delete(id);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        this.send(ws, {
          type: 'done',
          id,
          stop_reason: 'cancelled',
          usage: { input_tokens: 0, output_tokens: 0 },
          provider,
        });
      } else {
        this.send(ws, {
          type: 'error',
          id,
          error: err instanceof Error ? err.message : 'fetch failed',
          retryable: true,
        });
      }
      return;
    }

    if (!resp.ok) {
      this.activeChats.delete(id);
      const text = await resp.text().catch(() => '');
      this.send(ws, {
        type: 'error',
        id,
        error: `upstream ${resp.status} (${provider}): ${text.slice(0, 500)}`,
        retryable: resp.status >= 500 || resp.status === 429,
      });
      return;
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReason = 'end_turn';
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const evt of events) {
          const parsed = parseSSE(evt);
          if (!parsed.event) continue;

          // Per-provider event translation. Anthropic is identity;
          // OpenRouter rewrites server-tool names back to scribian
          // canonical so the plugin renderer doesn't branch.
          const translated = dispatch.translateEvent(
            parsed.event,
            parsed.data,
          );

          this.send(ws, {
            type: 'chunk',
            id,
            event: translated.event,
            data: translated.data,
          });

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
    } catch (err) {
      this.activeChats.delete(id);
      if (err instanceof Error && err.name === 'AbortError') {
        this.send(ws, {
          type: 'done',
          id,
          stop_reason: 'cancelled',
          usage,
          provider,
        });
        return;
      }
      this.send(ws, {
        type: 'error',
        id,
        error: err instanceof Error ? err.message : 'stream error',
        retryable: true,
      });
      return;
    }

    this.activeChats.delete(id);
    console.log(
      `chat ${id} done (${provider}): stop=${stopReason} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );
    this.send(ws, { type: 'done', id, stop_reason: stopReason, usage, provider });
  }
}

function isWriteToolName(name: string): boolean {
  return (
    name === 'write_note' || name === 'edit_note' || name === 'append_to_note'
  );
}

function safeParseHeader<T>(header: string | null, fallback: T): T {
  if (!header) return fallback;
  try {
    return JSON.parse(header) as T;
  } catch {
    return fallback;
  }
}

interface ParsedSSE {
  event: string;
  data: unknown;
}

function parseSSE(event: string): ParsedSSE {
  let eventName = '';
  let dataStr = '';
  for (const line of event.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataStr += line.slice(5).trim();
    }
  }
  if (!dataStr) return { event: eventName, data: null };
  try {
    return { event: eventName, data: JSON.parse(dataStr) };
  } catch {
    return { event: eventName, data: null };
  }
}
