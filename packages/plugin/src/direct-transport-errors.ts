/**
 * Maps a provider HTTP error status into a single human sentence plus
 * a retryable flag. Extracted from direct-transport.ts so the transport
 * stays under the size cap and the user-facing copy is unit-testable in
 * isolation.
 *
 * Contract: the user sees the `error` string only. A provider error body
 * contributes at most its short `type: message` text; headers and keys are
 * never echoed.
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

/** A fetch that never got a response from an OpenAI-compatible endpoint. */
export const ENDPOINT_UNREACHABLE_MESSAGE =
  "Couldn't reach the endpoint. Check the URL, or that it allows browser requests (CORS).";

/**
 * Friendly message + retryable flag for a non-OK HTTP status.
 * 429 / 5xx / network are retryable; 4xx (auth, bad request) are not.
 */
const DETAIL_MAX = 200;

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/** Short `type: message` text from a provider error body, or empty. */
export function providerErrorDetail(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const err = (parsed as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return clip(err.replace(/\s+/g, ' ').trim());
  if (!err || typeof err !== 'object') return '';
  const { type, message } = err as { type?: unknown; message?: unknown };
  const parts = [type, message].filter((p): p is string => typeof p === 'string' && p !== '');
  const text = parts.join(': ').replace(/\s+/g, ' ');
  return clip(text);
}

export function httpErrorMessage(
  status: number,
  retryAfter?: string | null,
  detail?: string,
): FriendlyError {
  const out = baseHttpError(status, retryAfter);
  return detail ? { ...out, error: `${out.error} (${detail})` } : out;
}

function baseHttpError(status: number, retryAfter?: string | null): FriendlyError {
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
  if (status === 402) {
    return {
      error: 'The provider reports no credits or a billing problem — check your account balance.',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      error: 'Model not found. Check the model id and base URL in Settings → Skald.',
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
      error: 'The provider returned a server error. Try again in a moment.',
      retryable: true,
    };
  }
  return {
    error: `Something went wrong (error ${status}) — try again or check your settings.`,
    retryable: false,
  };
}
