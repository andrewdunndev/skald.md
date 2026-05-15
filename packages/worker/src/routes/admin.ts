import type { Env } from '../env';
import { TokenRegistry, hasScope } from '../auth';
import { authBearerOrQuery } from './auth-helpers';

/**
 * Top-level /admin route. Authenticates, then forwards the request to
 * the DO with non-secret state attached as headers. The DO renders
 * the HTML page (it owns the connected-WS count and recent-events).
 */
export async function handleAdminRoute(
  req: Request,
  env: Env,
  registry: TokenRegistry,
  sessionDoName: string,
): Promise<Response> {
  const auth = authBearerOrQuery(req, registry);
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status });
  }
  if (!hasScope(auth.result.scopes, 'chat')) {
    return new Response('admin page requires chat scope', { status: 403 });
  }
  const stub = env.SCRIBIAN_SESSION.get(
    env.SCRIBIAN_SESSION.idFromName(sessionDoName),
  );
  const fwd = new Request(req.url, {
    method: 'GET',
    headers: new Headers({
      'x-scribian-admin-token-summaries': JSON.stringify(
        registry.tokenSummaries(),
      ),
      'x-scribian-admin-env-snapshot': JSON.stringify({
        anthropic: !!env.ANTHROPIC_API_KEY,
        openrouter: !!env.OPENROUTER_API_KEY,
        aigw: !!env.AI_GATEWAY_URL,
      }),
    }),
  });
  return stub.fetch(fwd);
}
