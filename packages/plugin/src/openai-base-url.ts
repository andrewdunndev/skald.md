/**
 * Validation for the user-supplied OpenAI-compatible base URL.
 *
 * Security requirement: prompts (including vault content) and the API
 * key are sent to this URL, so it MUST be https — except for loopback
 * addresses, where plain http is fine because the traffic never leaves
 * the machine (a common self-hosted setup, e.g. http://localhost:11434).
 *
 * Used both at settings-save time (to warn the user) and inside the
 * transport (to refuse to dispatch over a cleartext non-loopback URL)
 * so the rule cannot be bypassed by editing data.json directly.
 */

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

/** True for hostnames that resolve to the local machine. */
export function isLoopbackHost(hostname: string): boolean {
  // URL hostnames for IPv6 are bracketed, e.g. "[::1]".
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8 is entirely loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export interface BaseUrlValidation {
  ok: boolean;
  /** Present when ok === false. Suitable for a Notice. */
  error?: string;
}

/**
 * Validate an OpenAI-compatible base URL. Empty input is treated as
 * "ok" (no URL configured yet — callers gate on emptiness separately).
 */
export function validateOpenAiBaseUrl(raw: string): BaseUrlValidation {
  const value = raw.trim();
  if (!value) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Base URL is not a valid URL.' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'https:') return { ok: true };
  if (protocol === 'http:') {
    if (isLoopbackHost(parsed.hostname)) return { ok: true };
    return {
      ok: false,
      error:
        'Base URL must use https. Plain http is only allowed for ' +
        'loopback addresses (localhost / 127.0.0.1).',
    };
  }
  return {
    ok: false,
    error: `Unsupported URL scheme "${protocol}". Use https (or http for loopback).`,
  };
}
