import type { TokenRegistry, AuthResult } from '../auth';

export type AuthAttempt =
  | { ok: true; result: AuthResult }
  | { ok: false; reason: string; status: number };

export function authBearer(req: Request, registry: TokenRegistry): AuthAttempt {
  const header = req.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing bearer', status: 401 };
  }
  const candidate = header.slice(7).trim();
  const auth = registry.authenticate(candidate);
  if (!auth) {
    return { ok: false, reason: 'bad token', status: 401 };
  }
  return { ok: true, result: auth };
}

/**
 * Same as authBearer but also accepts ?token=... in the query string for
 * the diagnostic page so you can paste a one-line URL into a browser.
 * Query-string tokens land in browser history; bearer header is preferred.
 */
export function authBearerOrQuery(
  req: Request,
  registry: TokenRegistry,
): AuthAttempt {
  const bearer = authBearer(req, registry);
  if (bearer.ok) return bearer;
  const url = new URL(req.url);
  const candidate = url.searchParams.get('token')?.trim() ?? '';
  if (!candidate) return bearer;
  const auth = registry.authenticate(candidate);
  if (!auth) return { ok: false, reason: 'bad token', status: 401 };
  return { ok: true, result: auth };
}

export function authSubprotocol(
  req: Request,
  registry: TokenRegistry,
): AuthAttempt {
  const rawProto = req.headers.get('Sec-WebSocket-Protocol') ?? '';
  if (!rawProto) {
    return { ok: false, reason: 'missing protocol', status: 401 };
  }
  const candidate = rawProto.split(',')[0]?.trim() ?? '';
  const auth = registry.authenticate(candidate);
  if (!auth) {
    return { ok: false, reason: 'bad token', status: 401 };
  }
  return { ok: true, result: auth };
}
