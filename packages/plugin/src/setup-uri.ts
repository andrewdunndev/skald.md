/**
 * Setup URI handler — obsidian://skald-setup?endpoint=<url>&token=<token>
 *
 * Use case: user deploys their Worker on a desktop machine + mints a
 * token, then opens the resulting URI on an iPad to onboard without
 * retyping the credentials on a phone keyboard. The URI is the
 * payload of an Apple Shortcut, an iOS share-sheet item, or a
 * plain link in a vault note.
 *
 * Security posture: the token is bearer-grade and grants the holder
 * the configured scopes. It lives in plugin data.json after this
 * handler accepts it, same as if the user had pasted it into
 * settings. Sharing this URI is equivalent to sharing the bearer
 * token — never publish it. The plugin surfaces a confirmation
 * Notice on success so the user knows the credentials moved.
 */

export interface SetupParams {
  endpoint: string;
  token: string;
}

/**
 * Parse the obsidian://skald-setup query string into SetupParams,
 * or return a reason describing why the URI is unusable. Pure
 * function — no I/O, no plugin state, no Notice surface. Tested in
 * isolation in setup-uri.test.ts.
 *
 * Validation rules:
 * - endpoint must be a syntactically valid URL with scheme http(s)
 *   (rules out file://, javascript:, etc.)
 * - token must be non-empty after trim
 * - both must be present
 */
export function parseSetupParams(
  raw: Record<string, string>,
): { ok: true; params: SetupParams } | { ok: false; reason: string } {
  const endpointRaw = (raw.endpoint ?? '').trim();
  const tokenRaw = (raw.token ?? '').trim();
  if (!endpointRaw) {
    return { ok: false, reason: 'missing endpoint parameter' };
  }
  if (!tokenRaw) {
    return { ok: false, reason: 'missing token parameter' };
  }
  let parsed: URL;
  try {
    parsed = new URL(endpointRaw);
  } catch {
    return { ok: false, reason: 'endpoint is not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      reason: `endpoint scheme must be http or https (got ${parsed.protocol})`,
    };
  }
  return {
    ok: true,
    params: { endpoint: endpointRaw, token: tokenRaw },
  };
}
