/**
 * Timeout constants for DirectTransport.
 */

/**
 * Abort the request if no response headers arrive within this window.
 *
 * Raised from 30s to 60s to give cold-starting models headroom: a
 * self-hosted endpoint (Ollama) loading a large model, or a provider
 * routing to a cold backend, can take well over 30s to emit the first
 * byte. 60s still bounds a genuinely hung connection, and a breach now
 * surfaces an actionable "took too long (may be cold-starting), try
 * again" retryable error rather than a silent cancel.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Abort a stalled stream if no chunk arrives within this window. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

