/**
 * Low-level provider call helpers for the capture flow.
 *
 * Separated from capture.ts (the orchestration layer) to keep each
 * file under the 400-LOC cap. This module is pure over its inputs —
 * it depends only on requestUrl from Obsidian (testable by mocking)
 * and the shared protocol constants.
 *
 * Two paths:
 *   workerCapture  — POSTs to the Worker's /capture endpoint.
 *   directCapture  — Calls the provider API from the plugin using
 *                    Obsidian's requestUrl (no CORS, no dangerous-
 *                    direct-browser-access header needed).
 */

import { requestUrl, type RequestUrlParam } from 'obsidian';
import {
  CAPTURE_MAX_PROMPT_BYTES,
  extractCaptureTitle,
  type Provider,
} from '@scribian/protocol';

export interface CaptureResult {
  body: string;
  title: string;
}

export interface WorkerCaptureOpts {
  workerUrl: string;
  workerToken: string;
  prompt: string;
  kind: string;
}

export interface DirectCaptureOpts {
  provider: Provider;
  anthropicApiKey: string;
  openrouterApiKey: string;
  defaultModel: string;
  openrouterModel: string;
  prompt: string;
}

/** POST to the Worker's /capture endpoint (worker mode). */
export async function workerCapture(
  opts: WorkerCaptureOpts,
): Promise<CaptureResult> {
  if (!opts.workerUrl || !opts.workerToken) {
    throw new Error('Worker URL + token must be configured for worker mode.');
  }
  const reqParams: RequestUrlParam = {
    url: `${opts.workerUrl.replace(/^ws/, 'http').replace(/\/$/, '')}/capture`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.workerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prompt: opts.prompt, kind: opts.kind }),
    throw: false,
  };
  const resp = await requestUrl(reqParams);
  if (resp.status >= 400) {
    throw new Error(
      `/capture returned ${resp.status}: ${resp.text.slice(0, 300)}`,
    );
  }
  const json = resp.json as { body?: string; title?: string };
  if (!json.body) throw new Error('/capture response missing body');
  return { body: json.body, title: json.title ?? '' };
}

/** Call the provider API directly from the plugin (direct mode).
 * Uses Obsidian's requestUrl — not subject to CORS, so plain
 * x-api-key / Authorization headers work without the
 * anthropic-dangerous-direct-browser-access header that native
 * browser fetch requires. */
export async function directCapture(
  opts: DirectCaptureOpts,
): Promise<CaptureResult> {
  const { provider, prompt } = opts;
  const apiKey =
    provider === 'openrouter'
      ? opts.openrouterApiKey.trim()
      : opts.anthropicApiKey.trim();
  if (!apiKey) {
    const which = provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
    const field =
      provider === 'openrouter' ? 'openrouterApiKey' : 'anthropicApiKey';
    throw new Error(
      `No ${which} API key configured. Add it in plugin settings (${field}).`,
    );
  }
  if (new TextEncoder().encode(prompt).length > CAPTURE_MAX_PROMPT_BYTES) {
    throw new Error(
      `Capture content too large (>${CAPTURE_MAX_PROMPT_BYTES / 1024} KB).`,
    );
  }
  const model =
    provider === 'openrouter' ? opts.openrouterModel : opts.defaultModel;
  const reqBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
  };
  const headers: Record<string, string> =
    provider === 'openrouter'
      ? {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://github.com/scribian/scribian',
          'X-OpenRouter-Title': 'scribian',
        }
      : {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        };
  const url =
    provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/messages'
      : 'https://api.anthropic.com/v1/messages';
  const resp = await requestUrl({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
    throw: false,
  });
  if (resp.status >= 400) {
    throw new Error(
      `${provider} API returned ${resp.status}: ${resp.text.slice(0, 300)}`,
    );
  }
  const json = resp.json as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  if (!text) throw new Error('Provider returned no text content');
  return { body: text, title: extractCaptureTitle(text) };
}
