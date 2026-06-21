/**
 * Maps a provider HTTP error status into a single human sentence plus
 * a retryable flag. Extracted from direct-transport.ts so the transport
 * stays under the size cap and the user-facing copy is unit-testable in
 * isolation.
 *
 * Contract: the user only ever sees the `error` string. Raw provider
 * response bodies are logged for debugging by the caller, never
 * surfaced here — nothing in this module accepts or echoes a body.
 */

export interface FriendlyError {
  /** One human sentence shown to the user. Never raw JSON or a body. */
  error: string;
  /** Whether resending the same turn might succeed. */
  retryable: boolean;
}

/** Friendly copy for a network / fetch failure (non-abort). */
export const NETWORK_ERROR_MESSAGE =
  'Lost the connection — check your network and resend.';

/**
 * Friendly message + retryable flag for a non-OK HTTP status.
 * 429 / 5xx / network are retryable; 4xx (auth, bad request) are not.
 */
export function httpErrorMessage(
  status: number,
  retryAfter?: string | null,
): FriendlyError {
  if (status === 429) {
    const hint = retryAfter ? ` (retry in ${retryAfter}s)` : '';
    return {
      error: `Rate limit reached — wait a moment and resend.${hint}`,
      retryable: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      error: 'Your API key was rejected — check it in Settings → Skald.',
      retryable: false,
    };
  }
  if (status === 400) {
    return {
      error:
        "The request was rejected by the provider. If you attached an image, try a smaller one. Otherwise try a new chat.",
      retryable: false,
    };
  }
  if (status === 413) {
    return {
      error:
        "That image may be too large for the selected model or provider — try a smaller image.",
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      error: "Claude's having a moment on its end — try again in a sec.",
      retryable: true,
    };
  }
  return {
    error: `Something went wrong (error ${status}) — try again or check your settings.`,
    retryable: false,
  };
}
