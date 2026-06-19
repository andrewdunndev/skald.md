/**
 * iOS share-sheet + URL-scheme capture (phase 8 / 8b).
 *
 * Trigger: `obsidian://skald-capture?...` (fired by an Apple
 * Shortcut). Flow: parseCaptureParams → CaptureService.run() →
 * plugin calls the provider API via requestUrl → write to the
 * captures folder.
 *
 * Privacy posture: transient pipe. The provider API holds nothing
 * post-response. Same trust as the chat path. Rate-limited at the
 * handler level — see CAPTURE_RATE_LIMIT_COUNT.
 */

import {
  normalizePath,
  Notice,
  requestUrl,
  TFile,
  TFolder,
  type App,
  type ObsidianProtocolData,
  type RequestUrlParam,
} from 'obsidian';
import {
  CAPTURE_DEFAULT_PROMPTS,
  CAPTURE_MAX_PROMPT_BYTES,
  extractCaptureTitle,
  type Provider,
} from '@skald/protocol';
import { SlidingWindow } from './rate-limit';
import {
  captureFilename,
  safeAtob,
  safeDecodeURIComponent,
} from './capture-util';

export { captureFilename } from './capture-util';

export type CaptureKind = 'url' | 'text' | 'image' | 'pdf';

export interface CaptureParams {
  kind: CaptureKind;
  /** URL-decoded content payload (text body, URL, or vault-relative
   * path of a staged binary). */
  content: string;
  /** Optional title hint from the share source (Safari page title,
   * etc). */
  title?: string;
  /** Optional custom prompt path override (vault-relative). */
  prompt?: string;
  /** If 'true', don't open the captured note after writing. */
  silent: boolean;
}

// Default prompts from protocol (single source of truth — no copy-paste).
const defaultPromptForKind = (kind: CaptureKind): string =>
  CAPTURE_DEFAULT_PROMPTS[kind] ?? CAPTURE_DEFAULT_PROMPTS['text']!;

/**
 * Parse an Obsidian protocol-handler payload into a typed
 * CaptureParams. Defaults missing fields; ignores unknown keys.
 * Returns null if `payload` is empty (nothing to capture).
 *
 * Pure — depends only on the input data shape. Useful unit-test
 * surface: every Apple-Shortcut variation a user might cook up
 * lands here first.
 */
export function parseCaptureParams(
  data: ObsidianProtocolData,
): CaptureParams | null {
  const raw = data.payload;
  const b64 = data.b64 === 'true';
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const content = b64 ? safeAtob(raw) : safeDecodeURIComponent(raw);
  if (!content) return null;

  const kindRaw = typeof data.kind === 'string' ? data.kind : 'text';
  const kind: CaptureKind =
    kindRaw === 'url' || kindRaw === 'image' || kindRaw === 'pdf'
      ? kindRaw
      : 'text';
  return {
    kind,
    content,
    title: typeof data.title === 'string' ? data.title : undefined,
    prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
    silent: data.silent === 'true',
  };
}

/**
 * Compose the user-turn prompt that gets sent to the provider.
 * Pure; tested with concrete in/out.
 *
 *   - `params.prompt` (note path) takes precedence; the resolver
 *     reads that note's body and uses it verbatim as the system
 *     prompt prefix, with the captured content appended.
 *   - Otherwise the kind-default prompt is used.
 */
export function buildCapturePrompt(
  params: CaptureParams,
  customPromptBody: string | null,
): string {
  const head = customPromptBody?.trim() || defaultPromptForKind(params.kind);
  const titleHint = params.title
    ? `\n\nTitle hint from share source: ${params.title}`
    : '';
  return `${head}${titleHint}\n\n---\n\n${params.content}`;
}

// captureFilename + slugify + safeAtob + safeDecodeURIComponent
// live in ./capture-util.ts so this file stays focused on the
// CaptureService orchestration.

export interface CaptureServiceConfig {
  /** Active provider. */
  provider: Provider;
  /** Anthropic API key. */
  anthropicApiKey: string;
  /** OpenRouter API key. */
  openrouterApiKey: string;
  /** Default Anthropic model id. */
  defaultModel: string;
  /** Default OpenRouter model id. */
  openrouterModel: string;
  captureFolder: string;
  /** Vault-relative path of a prompt-template note. Empty → use
   * the kind-default prompt baked into this module. */
  promptPath: string;
}

interface CaptureResult {
  body: string;
  title: string;
}

/** Call the provider API directly from the plugin. Uses Obsidian's
 * requestUrl — not subject to CORS, so plain x-api-key / Authorization
 * headers work without the anthropic-dangerous-direct-browser-access
 * header that native browser fetch requires. */
async function directCapture(
  cfg: CaptureServiceConfig,
  prompt: string,
): Promise<CaptureResult> {
  const { provider } = cfg;
  const apiKey =
    provider === 'openrouter'
      ? cfg.openrouterApiKey.trim()
      : cfg.anthropicApiKey.trim();
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
    provider === 'openrouter' ? cfg.openrouterModel : cfg.defaultModel;
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
          'HTTP-Referer': 'https://github.com/skald/skald',
          'X-OpenRouter-Title': 'skald',
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
  const params: RequestUrlParam = {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
    throw: false,
  };
  const resp = await requestUrl(params);
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

/** Rate limit on the capture protocol handler. The handler can be
 * fired by ANY page that crafts an `obsidian://skald-capture`
 * URL — an iframe in a hostile webpage could fire it in a loop to
 * drain the user's Anthropic/OpenRouter spend. 5 captures per 60
 * seconds covers normal share-sheet bursts (forwarding a few
 * articles in quick succession) without enabling abuse. Above
 * the threshold, captures are rejected with a Notice. */
export const CAPTURE_RATE_LIMIT_COUNT = 5;
export const CAPTURE_RATE_LIMIT_WINDOW_MS = 60_000;

export class CaptureService {
  private readonly limiter = new SlidingWindow(
    CAPTURE_RATE_LIMIT_COUNT,
    CAPTURE_RATE_LIMIT_WINDOW_MS,
  );

  constructor(
    private readonly app: App,
    private readonly cfg: () => CaptureServiceConfig,
  ) {}

  async handleProtocol(data: ObsidianProtocolData): Promise<void> {
    const params = parseCaptureParams(data);
    if (!params) {
      new Notice('skald: capture had no content to process.');
      return;
    }
    if (this.limiter.isExceeded()) {
      new Notice(
        `skald: capture rate-limit hit (${CAPTURE_RATE_LIMIT_COUNT}/min). If this is unexpected, a webpage may be firing capture URLs — check what's open.`,
        10_000,
      );
      console.warn(
        `skald: capture rejected by rate-limit (${this.limiter.size()} in ${CAPTURE_RATE_LIMIT_WINDOW_MS / 1000}s window)`,
      );
      return;
    }
    this.limiter.record();
    const progress = new Notice('skald: capturing…', 0);
    try {
      const note = await this.run(params);
      progress.hide();
      new Notice(`skald: captured → ${note.path}`, 5000);
      if (!params.silent) {
        await this.app.workspace.openLinkText(note.path, '', false);
      }
    } catch (err) {
      progress.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`skald: capture failed — ${msg}`, 8000);
    }
  }

  /** Run a capture end-to-end: prompt → provider call → vault write.
   * Returns the resolved path. Exposed for testing / future
   * programmatic capture sources (browser extension). */
  async run(
    params: CaptureParams,
  ): Promise<{ path: string; routedTo: 'create' }> {
    const cfg = this.cfg();
    const customPromptBody = await this.readPromptTemplate(cfg.promptPath);
    const prompt = buildCapturePrompt(params, customPromptBody);

    const { body: captureBody, title: captureTitle } = await directCapture(
      cfg,
      prompt,
    );

    await this.ensureFolder(cfg.captureFolder);
    const filename = captureFilename(
      cfg.captureFolder,
      captureTitle || params.title || null,
    );
    const path = normalizePath(filename);
    await this.app.vault.create(path, captureBody);
    return { path, routedTo: 'create' };
  }

  private async readPromptTemplate(promptPath: string): Promise<string | null> {
    const p = promptPath?.trim();
    if (!p) return null;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(p));
    if (!(file instanceof TFile)) return null;
    try {
      const body = await this.app.vault.cachedRead(file);
      return body.startsWith('---\n')
        ? body.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
        : body.trim();
    } catch {
      return null;
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    const f = folder.trim();
    if (!f) return;
    const normalized = normalizePath(f);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;
    if (existing) return; // path collision (file with same name) — leave alone
    await this.app.vault.createFolder(normalized);
  }
}
