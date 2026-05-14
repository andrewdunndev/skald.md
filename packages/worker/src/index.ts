import type { ClientMessage, ServerMessage } from '@scribian/protocol';

export interface Env {
  SCRIBIAN_TOKEN: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  // CF Workers exposes crypto.timingSafeEqual as a non-standard extension.
  // @ts-expect-error - not in standard TS lib types
  return crypto.timingSafeEqual(ab, bb);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const proto = req.headers.get('Sec-WebSocket-Protocol') ?? '';
    if (!proto || !timingSafeEqual(proto, env.SCRIBIAN_TOKEN)) {
      return new Response('nope', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    server.addEventListener('message', (event) => {
      let reply: ServerMessage;
      try {
        const raw = typeof event.data === 'string' ? event.data : '';
        const msg = JSON.parse(raw) as ClientMessage;
        reply = handle(msg);
      } catch (err) {
        reply = {
          type: 'error',
          error: err instanceof Error ? err.message : 'parse error',
        };
      }
      server.send(JSON.stringify(reply));
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': proto },
    });
  },
};

function handle(msg: ClientMessage): ServerMessage {
  if (msg.type === 'echo') {
    return {
      type: 'echoed',
      id: msg.id,
      text: msg.text,
      received_at: Date.now(),
    };
  }
  if (msg.type === 'ping') {
    return { type: 'pong' };
  }
  return { type: 'error', error: 'unknown message type' };
}
