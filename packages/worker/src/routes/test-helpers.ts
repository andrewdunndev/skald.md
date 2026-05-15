/**
 * Shared test fixtures for route handler tests. Centralizes the
 * TokenRegistry + DO stub setup so each route's tests stay
 * focused on its own gating + dispatch shape.
 */

import { TokenRegistry } from '../auth';
import type { Env } from '../env';

export const DO_NAME = 'scribian-default';

export function makeRegistry(): TokenRegistry {
  return new TokenRegistry({
    SCRIBIAN_TOKENS: JSON.stringify([
      { label: 'plugin', token: 'tok-plugin', scopes: ['chat'] },
      { label: 'claude-code', token: 'tok-mcp', scopes: ['mcp:read'] },
      { label: 'noscope', token: 'tok-empty', scopes: [] },
    ]),
  });
}

/** Recording DO stub: every forwarded request lands in `received`
 * so tests can assert what the route sent. The stub returns a fixed
 * 200 OK so the route's response shape is whatever it forwards back. */
export function makeDOStub() {
  const received: Request[] = [];
  const stub = {
    fetch: async (req: Request) => {
      received.push(req);
      return new Response('forwarded', { status: 200 });
    },
  };
  const env = {
    SCRIBIAN_SESSION: {
      idFromName: (name: string) => ({ name }),
      get: () => stub,
    },
  } as unknown as Env;
  return { env, received };
}
