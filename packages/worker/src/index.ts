import type {
  ChatRequest,
  ClientMessage,
  ServerMessage,
  Usage,
} from '@scribian/protocol';
import {
  MCP_TOOLS,
  doNameForToken,
  rpcError,
  rpcResult,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  type JsonRpcRequest,
} from './mcp';

export interface Env {
  SCRIBIAN_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  SCRIBIAN_SESSION: DurableObjectNamespace;
  AI_GATEWAY_URL?: string;
}

const DIRECT_ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const SCRIBIAN_USER_AGENT = 'scribian/0.0.1 (https://gitlab.com/dunn.dev/scribian)';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TOOL_TIMEOUT_MS = 8000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        anthropic_key_present: !!env.ANTHROPIC_API_KEY,
        ai_gateway: !!env.AI_GATEWAY_URL,
        version: 4,
        mcp: '/mcp',
      });
    }

    // MCP endpoint — HTTP JSON-RPC. Bearer-token auth (same SCRIBIAN_TOKEN
    // as the plugin uses). Routes to the same DO instance as the plugin
    // so we can forward tool calls over the plugin's existing WS.
    if (url.pathname === '/mcp') {
      const auth = req.headers.get('Authorization') ?? '';
      if (!auth.startsWith('Bearer ')) {
        return new Response('missing bearer', { status: 401 });
      }
      const token = auth.slice(7).trim();
      if (!env.SCRIBIAN_TOKEN || !timingSafeEqual(token, env.SCRIBIAN_TOKEN)) {
        return new Response('bad token', { status: 401 });
      }
      const name = await doNameForToken(token);
      const stub = env.SCRIBIAN_SESSION.get(env.SCRIBIAN_SESSION.idFromName(name));
      return stub.fetch(req);
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const rawProto = req.headers.get('Sec-WebSocket-Protocol') ?? '';
    if (!rawProto) {
      return new Response('missing protocol', { status: 401 });
    }
    if (!env.SCRIBIAN_TOKEN) {
      return new Response('server misconfigured: SCRIBIAN_TOKEN not set', {
        status: 500,
      });
    }
    const candidate = rawProto.split(',')[0]?.trim() ?? '';
    if (!timingSafeEqual(candidate, env.SCRIBIAN_TOKEN)) {
      return new Response('bad token', { status: 401 });
    }

    // Token-derived DO name so plugin + MCP client reach the same DO
    // instance; the MCP bridge needs the plugin's WS to forward calls.
    const name = await doNameForToken(candidate);
    const stub = env.SCRIBIAN_SESSION.get(env.SCRIBIAN_SESSION.idFromName(name));
    return stub.fetch(req);
  },
};

export class ScribianSession {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly activeChats: Map<string, AbortController> = new Map();
  // MCP tool calls awaiting plugin response. Keyed by the id we generated
  // when forwarding the call.
  private readonly pendingMcp: Map<
    string,
    (result: { content: string; is_error?: boolean }) => void
  > = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // MCP requests come in via HTTP (no upgrade). Handle as JSON-RPC.
    if (url.pathname === '/mcp') {
      return this.handleMcp(req);
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
      const supplied = msg.anthropic_api_key?.trim();
      const apiKey = supplied || this.env.ANTHROPIC_API_KEY;
      await this.runChat(ws, apiKey, msg.id, msg.payload);
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

  private async handleMcp(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      // Streamable HTTP MCP transport spec also supports GET for
      // server-initiated SSE; we don't support that. Return 405.
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

    // Handle both single requests and batched requests.
    const requests = Array.isArray(body) ? body : [body];
    const responses: unknown[] = [];
    for (const r of requests) {
      const reply = await this.handleRpc(r as JsonRpcRequest);
      if (reply !== null) responses.push(reply);
    }

    if (responses.length === 0) {
      // All requests were notifications (no id); return 202.
      return new Response(null, { status: 202 });
    }
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  }

  private async handleRpc(rpc: JsonRpcRequest): Promise<unknown | null> {
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return rpcError(rpc?.id ?? null, INVALID_REQUEST, 'invalid request');
    }
    const isNotification = rpc.id === undefined || rpc.id === null;

    try {
      switch (rpc.method) {
        case 'initialize':
          return rpcResult(rpc.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'scribian', version: '0.0.1' },
          });

        case 'notifications/initialized':
          // No response for notifications
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
          const result = await this.bridgeToolCall(params.name, params.arguments);
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

  /**
   * Forward an MCP tool call to whichever plugin WS is attached to this
   * DO. Returns the result the plugin produced, or an error if no
   * plugin is connected / it times out.
   */
  private async bridgeToolCall(
    name: string,
    input: unknown,
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

    // Send to the first connected plugin. If the user has Mac + iPhone
    // both open, only the first ws gets the call — fine for v1.
    this.send(sockets[0], {
      type: 'mcp_call',
      id: callId,
      name,
      input,
    });

    return Promise.race([promise, timeout]);
  }

  private async runChat(
    ws: WebSocket,
    apiKey: string | undefined,
    id: string,
    req: ChatRequest,
  ): Promise<void> {
    if (!apiKey) {
      this.send(ws, {
        type: 'error',
        id,
        error:
          'No Anthropic API key. Set it in plugin settings (preferred) or on the Worker secret ANTHROPIC_API_KEY.',
        retryable: false,
      });
      return;
    }

    const upstreamUrl = this.env.AI_GATEWAY_URL || DIRECT_ANTHROPIC_URL;
    const via = this.env.AI_GATEWAY_URL ? 'aigw' : 'direct';

    console.log(
      `chat ${id} (${via}): model=${req.model} messages=${req.messages.length} tools=${req.tools?.length ?? 0} system=${!!req.system}`,
    );

    const ac = new AbortController();
    this.activeChats.set(id, ac);

    const upstreamHeaders: Record<string, string> = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'user-agent': SCRIBIAN_USER_AGENT,
    };

    if (this.env.AI_GATEWAY_URL) {
      upstreamHeaders['cf-aig-metadata'] = JSON.stringify({
        app: 'scribian',
        model: req.model,
        has_tools: !!(req.tools && req.tools.length > 0),
      });
    }

    let resp: Response;
    try {
      resp = await fetch(upstreamUrl, {
        method: 'POST',
        signal: ac.signal,
        headers: upstreamHeaders,
        body: JSON.stringify({ ...req, stream: true }),
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
        error: `upstream ${resp.status}: ${text.slice(0, 500)}`,
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

          this.send(ws, {
            type: 'chunk',
            id,
            event: parsed.event,
            data: parsed.data,
          });

          const d = parsed.data as Record<string, any> | null;
          if (parsed.event === 'message_start' && d?.message?.usage) {
            usage = { ...usage, ...d.message.usage };
          }
          if (parsed.event === 'message_delta') {
            if (d?.usage) usage = { ...usage, ...d.usage };
            if (d?.delta?.stop_reason) stopReason = d.delta.stop_reason;
          }
        }
      }
    } catch (err) {
      this.activeChats.delete(id);
      if (err instanceof Error && err.name === 'AbortError') {
        this.send(ws, { type: 'done', id, stop_reason: 'cancelled', usage });
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
      `chat ${id} done: stop=${stopReason} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );
    this.send(ws, { type: 'done', id, stop_reason: stopReason, usage });
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
