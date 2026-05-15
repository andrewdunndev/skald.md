import type { ServerMessage } from '@scribian/protocol';
import type { Env } from '../env';
import { TokenRegistry, hasScope } from '../auth';
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
} from '../mcp';
import { authBearer } from './auth-helpers';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TOOL_TIMEOUT_MS = 8000;
/** Max bytes for an /mcp request body. JSON-RPC payloads are tiny
 * in practice (method + small params); a multi-MB body is either
 * a misconfigured client or someone trying to drain the DO's
 * parse compute. */
const MCP_MAX_BODY_BYTES = 256 * 1024;

/**
 * Top-level /mcp route. Auth + scope check, then forward to the
 * session DO which runs the JSON-RPC handler (it owns the WS pool +
 * pending-call map needed to bridge tools/call to the plugin).
 */
export async function handleMcpRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
  sessionDoName: string,
): Promise<Response> {
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
    env.SCRIBIAN_SESSION.idFromName(sessionDoName),
  );
  // Pass caller label through a header so the DO can include it
  // when forwarding to the plugin.
  const fwd = new Request(req, { headers: new Headers(req.headers) });
  fwd.headers.set('x-scribian-caller-label', auth.result.label);
  return stub.fetch(fwd);
}

export interface McpContext {
  sockets: () => WebSocket[];
  pendingMcp: Map<
    string,
    (result: { content: string; is_error?: boolean }) => void
  >;
  send: (ws: WebSocket, msg: ServerMessage) => void;
  record: (method: string, callerLabel: string) => void;
}

/**
 * MCP JSON-RPC entry point. Lives on the DO side because tools/call
 * needs the connected WebSocket pool to bridge into the plugin.
 */
export async function handleMcpRpc(
  req: Request,
  callerLabel: string,
  ctx: McpContext,
): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  // Cap before parse: a multi-MB JSON body would burn DO compute
  // on JSON.parse before any RPC validation runs.
  const lenHeader = req.headers.get('content-length');
  if (lenHeader && parseInt(lenHeader, 10) > MCP_MAX_BODY_BYTES) {
    return new Response('mcp body exceeds size cap', { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > MCP_MAX_BODY_BYTES) {
    return new Response('mcp body exceeds size cap', { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json(rpcError(null, PARSE_ERROR, 'invalid JSON'));
  }

  const requests = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const r of requests) {
    const reply = await dispatchRpc(r as JsonRpcRequest, callerLabel, ctx);
    if (reply !== null) responses.push(reply);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

async function dispatchRpc(
  rpc: JsonRpcRequest,
  callerLabel: string,
  ctx: McpContext,
): Promise<unknown | null> {
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return rpcError(rpc?.id ?? null, INVALID_REQUEST, 'invalid request');
  }
  const isNotification = rpc.id === undefined || rpc.id === null;

  console.log(`mcp call: label=${callerLabel} method=${rpc.method}`);
  ctx.record(rpc.method, callerLabel);

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
        const result = await bridgeToolCall(
          params.name,
          params.arguments,
          callerLabel,
          ctx,
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

async function bridgeToolCall(
  name: string,
  input: unknown,
  callerLabel: string,
  ctx: McpContext,
): Promise<{ content: string; is_error?: boolean }> {
  const sockets = ctx.sockets();
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
      ctx.pendingMcp.set(callId, resolve);
    },
  );
  const timeout = new Promise<{ content: string; is_error?: boolean }>(
    (resolve) =>
      setTimeout(() => {
        ctx.pendingMcp.delete(callId);
        resolve({
          content: `Plugin did not respond within ${MCP_TOOL_TIMEOUT_MS}ms.`,
          is_error: true,
        });
      }, MCP_TOOL_TIMEOUT_MS),
  );

  ctx.send(sockets[0], {
    type: 'mcp_call',
    id: callId,
    name,
    input,
    caller_label: callerLabel,
  });

  return Promise.race([promise, timeout]);
}

function isWriteToolName(name: string): boolean {
  return (
    name === 'write_note' ||
    name === 'edit_note' ||
    name === 'append_to_note' ||
    name === 'remember_fact' ||
    name === 'update_memory' ||
    name === 'forget_fact'
  );
}
