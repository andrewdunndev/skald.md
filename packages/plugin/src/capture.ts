/**
 * iOS share-sheet capture, text only.
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
  TFile,
  TFolder,
  type App,
  type ObsidianProtocolData,
} from 'obsidian';
import type { Provider } from './protocol';
import { SlidingWindow } from './rate-limit';
import { utilityComplete } from './utility-call';
import { validateOpenAiBaseUrl } from './openai-base-url';
import {
  captureFilename,
  safeAtob,
  safeDecodeURIComponent,
} from './capture-util';

export { captureFilename } from './capture-util';

/** Max bytes for a capture prompt, bounding upstream spend. */
export const CAPTURE_MAX_PROMPT_BYTES = 100 * 1024;

/** Default capture prompt; a settings note can replace it. */
export const CAPTURE_PROMPT =
  'The user shared this text from their phone. Process it into a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, suggest tags. If it is only a link, keep the link and do not guess at what the page says.';

/** Title of a capture body: first H1 if present, else first non-empty line, capped at 60 chars. */
export function extractCaptureTitle(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const titleMatch = firstLine.match(/^#+\s+(.*)$/);
  return (titleMatch?.[1] ?? firstLine).slice(0, 60).trim();
}

export const CAPTURE_OFF_NOTICE =
  'Skald: share-sheet capture is off. Turn on "Allow share-sheet capture" in Settings → Skald → Advanced.';

export const CAPTURE_TEXT_ONLY_NOTICE =
  'Skald: capture takes text only. Share the text or link itself.';

export interface CaptureParams {
  /** Decoded shared text; a shared URL arrives as text too. */
  content: string;
  /** Optional title hint from the share source (Safari page title,
   * etc). */
  title?: string;
  /** If 'true', don't open the captured note after writing. */
  silent: boolean;
}

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
  return {
    content,
    title: typeof data.title === 'string' ? data.title : undefined,
    silent: data.silent === 'true',
  };
}

/**
 * Compose the user-turn prompt that gets sent to the provider: the
 * custom prompt note's body when set, else the default, then the
 * shared text.
 */
export function buildCapturePrompt(
  params: CaptureParams,
  customPromptBody: string | null,
): string {
  const head = customPromptBody?.trim() || CAPTURE_PROMPT;
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
  /** Anthropic API key, resolved from secret storage. */
  anthropicApiKey: string;
  /** OpenRouter API key, resolved from secret storage. */
  openrouterApiKey: string;
  /** Default Anthropic model id. */
  defaultModel: string;
  /** Default OpenRouter model id. */
  openrouterModel: string;
  /** OpenAI-compatible Bearer token, resolved from secret storage. */
  openaiApiKey: string;
  /** OpenAI-compatible model id. */
  openaiModel: string;
  /** OpenAI-compatible base URL. */
  openaiBaseUrl: string;
  /**
   * Cheap/utility model for this capture pass (from utilityModel(settings)).
   * Capture is a one-shot summarise/tag task — it should run on the Haiku
   * tier, not the reasoning model the user picked for chat.
   */
  utilityModel: string;
  captureFolder: string;
  /** Vault-relative path of a prompt-template note. Empty → use
   * the default capture prompt. */
  promptPath: string;
}

interface CaptureResult {
  body: string;
  title: string;
}

/** Call the provider API directly from the plugin. Delegates to
 * utilityComplete (utility-call.ts) which uses Obsidian's requestUrl —
 * not subject to CORS, so plain x-api-key / Authorization headers work
 * without the anthropic-dangerous-direct-browser-access header that
 * native browser fetch requires. */
async function directCapture(
  cfg: CaptureServiceConfig,
  prompt: string,
): Promise<CaptureResult> {
  const { provider } = cfg;
  const apiKey =
    provider === 'openrouter'
      ? cfg.openrouterApiKey.trim()
      : provider === 'openai'
        ? cfg.openaiApiKey.trim()
        : cfg.anthropicApiKey.trim();
  const baseUrl = provider === 'openai' ? cfg.openaiBaseUrl.trim() : undefined;
  // OpenAI-compatible endpoints may need no key; gate on base URL instead.
  if (provider === 'openai') {
    if (!baseUrl) {
      throw new Error(
        'No OpenAI-compatible base URL configured. Add it in plugin settings (openaiBaseUrl).',
      );
    }
    // Defense-in-depth: refuse to send capture content (vault data) + the
    // API key over a cleartext non-loopback URL, even if a hand-edited
    // data.json slipped one past loadSettings' clamp.
    const validation = validateOpenAiBaseUrl(baseUrl);
    if (!validation.ok) {
      throw new Error(
        validation.error ?? 'OpenAI-compatible base URL is not allowed.',
      );
    }
  } else if (!apiKey) {
    const which = provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
    throw new Error(
      `No ${which} API key in secret storage on this device. Add it in Settings → Skald.`,
    );
  }
  if (new TextEncoder().encode(prompt).length > CAPTURE_MAX_PROMPT_BYTES) {
    throw new Error(
      `Capture content too large (>${CAPTURE_MAX_PROMPT_BYTES / 1024} KB).`,
    );
  }
  // Capture is a cheap one-shot summarise/tag task — route through
  // the utility (Haiku-tier) model, not the reasoning model the user
  // picked for chat. cfg.utilityModel is resolved by the caller via
  // utilityModel(settings) from provider-capabilities.ts.
  const model = cfg.utilityModel;

  const res = await utilityComplete(provider, apiKey, model, {
    userPrompt: prompt,
    maxTokens: 2048,
    baseUrl,
  });

  if (!res.ok) {
    throw new Error(
      `${provider} API returned ${res.status}: ${res.errorText ?? ''}`,
    );
  }
  if (!res.text?.trim()) throw new Error('Provider returned no text content');
  const text = res.text.trim();
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
    if (data.kind !== undefined && data.kind !== 'text') {
      new Notice(CAPTURE_TEXT_ONLY_NOTICE);
      return;
    }
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
    const now = new Date();
    const filename = captureFilename(
      cfg.captureFolder,
      captureTitle || params.title || null,
      now,
    );
    const path = normalizePath(filename);
    // Collision guard: if a note already exists at the computed path (same-day
    // + same-title-slug), the original vault.create would fail and the capture
    // would be silently lost. Append the time component to uniquify, then
    // retry once. A user-triggered capture must never be discarded.
    if (this.app.vault.getAbstractFileByPath(path) != null) {
      const uniquePath = normalizePath(
        captureFilename(cfg.captureFolder, captureTitle || params.title || null, now, true),
      );
      await this.app.vault.create(uniquePath, captureBody);
      return { path: uniquePath, routedTo: 'create' };
    }
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
