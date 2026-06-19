import { describe, expect, it } from 'vitest';
import { handleChatRoute } from './chat';
import { DO_NAME, makeDOStub, makeRegistry } from './test-helpers';

describe('handleChatRoute (WS upgrade)', () => {
  it('returns 426 when Upgrade header is not websocket', async () => {
    const { env } = makeDOStub();
    const r = await handleChatRoute(
      new Request('https://w.example/'),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(426);
    expect(await r.text()).toBe('expected websocket');
  });

  // Subprotocol auth rejects 401 with the exact reason: no protocol
  // header -> "missing protocol"; unknown token -> "bad token". (The
  // reason semantics are owned by auth-helpers.test.ts authSubprotocol;
  // here we prove the chat route wires them as 401 responses.)
  it.each([
    { name: 'no Sec-WebSocket-Protocol header', proto: undefined, reason: 'missing protocol' },
    { name: 'subprotocol token is unknown', proto: 'wrong-token', reason: 'bad token' },
  ])('returns 401 when $name', async ({ proto, reason }) => {
    const { env } = makeDOStub();
    const headers: Record<string, string> = { Upgrade: 'websocket' };
    if (proto) headers['Sec-WebSocket-Protocol'] = proto;
    const r = await handleChatRoute(
      new Request('https://w.example/', { headers }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(401);
    expect(await r.text()).toBe(reason);
  });

  it('returns 403 when token lacks chat scope', async () => {
    const { env } = makeDOStub();
    const r = await handleChatRoute(
      new Request('https://w.example/', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': 'tok-empty',
        },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('token lacks chat scope');
  });

  it('forwards to the DO when subprotocol auth + chat scope pass', async () => {
    const { env, received } = makeDOStub();
    const r = await handleChatRoute(
      new Request('https://w.example/', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': 'tok-plugin',
        },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(200);
    expect(received).toHaveLength(1);
  });
});
