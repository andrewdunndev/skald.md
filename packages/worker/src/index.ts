import type {
  ChatRequest,
  ClientMessage,
  ServerMessage,
  Usage,
} from '@scribian/protocol';

export interface Env {
  SCRIBIAN_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  SCRIBIAN_SESSION: DurableObjectNamespace;
}

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
        version: 2,
      });
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const proto = req.headers.get('Sec-WebSocket-Protocol') ?? '';
    if (!proto) {
      return new Response('missing protocol', { status: 401 });
    }
    if (!env.SCRIBIAN_TOKEN) {
      return new Response('server misconfigured: SCRIBIAN_TOKEN not set', {
        status: 500,
      });
    }
    if (!timingSafeEqual(proto, env.SCRIBIAN_TOKEN)) {
      return new Response('bad token', { status: 401 });
    }

    // Per-session DO. Each upgrade gets a fresh DO instance with its
    // own state for that WebSocket. Hibernation API releases the JS
    // context between messages, only re-entering when traffic arrives.
    const id = env.SCRIBIAN_SESSION.newUniqueId();
    const stub = env.SCRIBIAN_SESSION.get(id);
    return stub.fetch(req);
  },
};

export class ScribianSession {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  // Per-WS in-flight chat AbortControllers, keyed by chat id. Lives
  // only while the DO instance is in-memory; persists across
  // hibernation cycles only as long as the JS context survives. For
  // cancel-during-streaming this is fine: the DO is awake while a
  // fetch is awaited, so the controller is reachable.
  private readonly activeChats: Map<string, AbortController> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation-mode accept: Workers handles the WS when this DO is
    // hibernated, dispatching to webSocketMessage / webSocketClose /
    // webSocketError when traffic arrives.
    this.state.acceptWebSocket(server);

    const proto = req.headers.get('Sec-WebSocket-Protocol') ?? '';
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': proto },
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
      const apiKey = msg.anthropic_api_key || this.env.ANTHROPIC_API_KEY;
      await this.runChat(ws, apiKey, msg.id, msg.payload);
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

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    for (const ac of this.activeChats.values()) ac.abort();
    this.activeChats.clear();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket closed mid-stream — silently drop
    }
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

    console.log(
      `chat ${id}: model=${req.model} messages=${req.messages.length} tools=${req.tools?.length ?? 0} system=${!!req.system}`,
    );

    const ac = new AbortController();
    this.activeChats.set(id, ac);

    let resp: Response;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
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
