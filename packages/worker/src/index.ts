import type {
  ChatRequest,
  ClientMessage,
  ServerMessage,
  Usage,
} from '@scribian/protocol';

export interface Env {
  SCRIBIAN_TOKEN: string;
  ANTHROPIC_API_KEY: string;
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

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const abortRegistry = new Map<string, AbortController>();

    server.addEventListener('message', (event) => {
      void handleClientMessage(server, env, event, abortRegistry);
    });

    server.addEventListener('close', () => {
      for (const ac of abortRegistry.values()) ac.abort();
      abortRegistry.clear();
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': proto },
    });
  },
};

async function handleClientMessage(
  server: WebSocket,
  env: Env,
  event: MessageEvent,
  abortRegistry: Map<string, AbortController>,
): Promise<void> {
  let msg: ClientMessage;
  try {
    const raw = typeof event.data === 'string' ? event.data : '';
    msg = JSON.parse(raw) as ClientMessage;
  } catch (err) {
    send(server, {
      type: 'error',
      error: err instanceof Error ? err.message : 'parse error',
    });
    return;
  }

  if (msg.type === 'ping') {
    send(server, { type: 'pong' });
    return;
  }

  if (msg.type === 'echo') {
    send(server, {
      type: 'echoed',
      id: msg.id,
      text: msg.text,
      received_at: Date.now(),
    });
    return;
  }

  if (msg.type === 'cancel') {
    abortRegistry.get(msg.id)?.abort();
    abortRegistry.delete(msg.id);
    return;
  }

  if (msg.type === 'chat') {
    const apiKey = msg.anthropic_api_key || env.ANTHROPIC_API_KEY;
    await runChat(server, apiKey, msg.id, msg.payload, abortRegistry);
    return;
  }

  send(server, { type: 'error', error: 'unknown message type' });
}

async function runChat(
  server: WebSocket,
  apiKey: string | undefined,
  id: string,
  req: ChatRequest,
  abortRegistry: Map<string, AbortController>,
): Promise<void> {
  if (!apiKey) {
    send(server, {
      type: 'error',
      id,
      error:
        'No Anthropic API key. Set it in plugin settings (preferred) or on the Worker secret ANTHROPIC_API_KEY.',
      retryable: false,
    });
    return;
  }

  const ac = new AbortController();
  abortRegistry.set(id, ac);

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
    abortRegistry.delete(id);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort) {
      send(server, {
        type: 'done',
        id,
        stop_reason: 'cancelled',
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } else {
      send(server, {
        type: 'error',
        id,
        error: err instanceof Error ? err.message : 'fetch failed',
        retryable: true,
      });
    }
    return;
  }

  if (!resp.ok) {
    abortRegistry.delete(id);
    const text = await resp.text().catch(() => '');
    send(server, {
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

        send(server, {
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
    abortRegistry.delete(id);
    if (err instanceof Error && err.name === 'AbortError') {
      send(server, { type: 'done', id, stop_reason: 'cancelled', usage });
      return;
    }
    send(server, {
      type: 'error',
      id,
      error: err instanceof Error ? err.message : 'stream error',
      retryable: true,
    });
    return;
  }

  abortRegistry.delete(id);
  send(server, { type: 'done', id, stop_reason: stopReason, usage });
}

function send(server: WebSocket, msg: ServerMessage): void {
  try {
    server.send(JSON.stringify(msg));
  } catch {
    // socket closed mid-stream — silently drop
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
