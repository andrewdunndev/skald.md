import type {
  ChatRequest,
  Provider,
  ServerMessage,
  Usage,
} from '@skald/protocol';
import type { Env } from '../env';
import { TokenRegistry, hasScope } from '../auth';
import { dispatchFor } from '../providers';
import { authSubprotocol } from './auth-helpers';

/**
 * Top-level WS upgrade route. Authenticates via Sec-WebSocket-Protocol
 * subprotocol header, checks chat scope, and forwards to the session
 * DO which completes the upgrade.
 */
export async function handleChatRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
  sessionDoName: string,
): Promise<Response> {
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
  const stub = env.SKALD_SESSION.get(
    env.SKALD_SESSION.idFromName(sessionDoName),
  );
  return stub.fetch(req);
}

export interface RunChatContext {
  activeChats: Map<string, AbortController>;
  send: (ws: WebSocket, msg: ServerMessage) => void;
}

/**
 * Streaming chat turn. Dispatches the user's request to the chosen
 * provider, pumps SSE through translation, and sends framed chunks
 * back over the WebSocket. The DO owns the abort-controller map +
 * send function; this stays a free helper so the routing surface
 * around chat lives next to its peers.
 */
export async function runChat(
  ws: WebSocket,
  env: Env,
  provider: Provider,
  apiKey: string | undefined,
  id: string,
  req: ChatRequest,
  ctx: RunChatContext,
): Promise<void> {
  if (!apiKey) {
    const which = provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
    const envName =
      provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    ctx.send(ws, {
      type: 'error',
      id,
      error: `No ${which} API key. Set it in plugin settings (preferred) or on the Worker secret ${envName}.`,
      retryable: false,
    });
    return;
  }

  const dispatch = dispatchFor(provider, apiKey, env, req);
  const via =
    provider === 'anthropic' && env.AI_GATEWAY_URL
      ? 'aigw'
      : provider === 'anthropic'
        ? 'direct'
        : 'openrouter';

  console.log(
    `chat ${id} (${via}): model=${req.model} messages=${req.messages.length} tools=${req.tools?.length ?? 0} system=${!!req.system}`,
  );

  const ac = new AbortController();
  ctx.activeChats.set(id, ac);

  let resp: Response;
  try {
    resp = await fetch(dispatch.url, {
      method: 'POST',
      signal: ac.signal,
      headers: dispatch.headers,
      body: JSON.stringify({ ...dispatch.request, stream: true }),
    });
  } catch (err) {
    ctx.activeChats.delete(id);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      ctx.send(ws, {
        type: 'done',
        id,
        stop_reason: 'cancelled',
        usage: { input_tokens: 0, output_tokens: 0 },
        provider,
      });
    } else {
      ctx.send(ws, {
        type: 'error',
        id,
        error: err instanceof Error ? err.message : 'fetch failed',
        retryable: true,
      });
    }
    return;
  }

  if (!resp.ok) {
    ctx.activeChats.delete(id);
    const text = await resp.text().catch(() => '');
    ctx.send(ws, {
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
        // OpenRouter rewrites server-tool names back to skald
        // canonical so the plugin renderer doesn't branch.
        const translated = dispatch.translateEvent(parsed.event, parsed.data);

        ctx.send(ws, {
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
    ctx.activeChats.delete(id);
    if (err instanceof Error && err.name === 'AbortError') {
      ctx.send(ws, {
        type: 'done',
        id,
        stop_reason: 'cancelled',
        usage,
        provider,
      });
      return;
    }
    ctx.send(ws, {
      type: 'error',
      id,
      error: err instanceof Error ? err.message : 'stream error',
      retryable: true,
    });
    return;
  }

  ctx.activeChats.delete(id);
  console.log(
    `chat ${id} done (${provider}): stop=${stopReason} in=${usage.input_tokens} out=${usage.output_tokens} cache_read=${usage.cache_read_input_tokens ?? 0}`,
  );
  ctx.send(ws, { type: 'done', id, stop_reason: stopReason, usage, provider });
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
