import { describe, expect, it } from 'vitest';
import { handleMcpRoute } from './mcp';
import { DO_NAME, makeDOStub, makeRegistry } from './test-helpers';

describe('handleMcpRoute', () => {
  it('returns 401 on missing Bearer', async () => {
    const { env } = makeDOStub();
    const r = await handleMcpRoute(
      new Request('https://w.example/mcp'),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(401);
  });

  it('returns 403 when token lacks mcp:read scope', async () => {
    const { env } = makeDOStub();
    const r = await handleMcpRoute(
      new Request('https://w.example/mcp', {
        headers: { Authorization: 'Bearer tok-empty' },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('mcp:read');
  });

  it('returns 403 when chat-only token tries MCP (no cross-scope leak)', async () => {
    const { env } = makeDOStub();
    const r = await handleMcpRoute(
      new Request('https://w.example/mcp', {
        headers: { Authorization: 'Bearer tok-plugin' },
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(r.status).toBe(403);
  });

  it('forwards to DO with x-scribian-caller-label header = token label', async () => {
    const { env, received } = makeDOStub();
    await handleMcpRoute(
      new Request('https://w.example/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-mcp',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        }),
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(received).toHaveLength(1);
    expect(received[0].headers.get('x-scribian-caller-label')).toBe(
      'claude-code',
    );
  });

  it('preserves the original method + body when forwarding', async () => {
    const { env, received } = makeDOStub();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await handleMcpRoute(
      new Request('https://w.example/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok-mcp',
          'content-type': 'application/json',
        },
        body,
      }),
      env,
      makeRegistry(),
      DO_NAME,
    );
    expect(received[0].method).toBe('POST');
    const fwdBody = await received[0].text();
    expect(fwdBody).toBe(body);
  });
});
