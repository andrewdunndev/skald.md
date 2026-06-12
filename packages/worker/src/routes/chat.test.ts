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

  it('returns 401 when no Sec-WebSocket-Protocol header (auth via subprotocol)', async () => {
    const { env } = makeDOStub();
    const r = await handleChatRoute(
      new Request('https://w.example/', {
        headers: { Upgrade: 'websocket' },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('missing protocol');
  });

  it('returns 401 when subprotocol token is unknown', async () => {
    const { env } = makeDOStub();
    const r = await handleChatRoute(
      new Request('https://w.example/', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': 'wrong-token',
        },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('bad token');
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
