/**
 * iOS share-sheet + URL-scheme capture (phase 8).
 *
 * A capture is a one-shot Claude turn that turns shared content
 * (a URL, a snippet of text, an image) into a vault note. The
 * trigger is `obsidian://scribian-capture?...` — fired by an Apple
 * Shortcut the user installs once; that Shortcut sits in the iOS
 * share-sheet target list.
 *
 * Flow:
 *   1. ProtocolData arrives → parseCaptureParams
 *   2. CaptureService.run() builds the prompt + POSTs /capture on
 *      the user's Worker
 *   3. Worker returns {body, title}; plugin writes it as a vault
 *      note in capturesFolder with a stable slug filename
 *   4. (optional) Plugin opens the captured note in a new pane
 *
 * The prompt-building and parameter parsing are pure functions —
 * unit-testable without an Obsidian runtime. The CaptureService
 * class composes them with vault I/O + HTTP.
 *
 * Privacy posture: capture is a transient pipe (incoming content →
 * Worker → Anthropic → response → vault). The Worker doesn't
 * persist captured content beyond the moment of processing — same
 * posture as the existing chat path. Captured content does pass
 * through your selected LLM provider; users opting in should know
 * the share-sheet handler does the same thing as typing the
 * content into the chat pane.
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

const DEFAULT_PROMPT_BY_KIND: Record<CaptureKind, string> = {
  url: 'The user shared this URL from their phone. Open it (or use what you know about it) and write a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, list any action items, suggest tags (Obsidian #tag format).',
  text: 'The user shared this text from their phone. Process it into a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, suggest tags.',
  image:
    'The user shared this image from their phone (you have access to it as an image attachment). Describe what is shown, transcribe any visible text, and write a vault-ready capture note: title (≤8 words), description, any extracted text, suggested tags.',
  pdf: 'The user shared this PDF from their phone. Process it into a vault-ready capture note: extract a title (≤8 words), summarize key points as bullets, identify any action items, suggest tags.',
};

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
 * Compose the user-turn prompt that gets sent to /capture on the
 * Worker. Pure; tested with concrete in/out.
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
  const head = customPromptBody?.trim() || DEFAULT_PROMPT_BY_KIND[params.kind];
  const titleHint = params.title
    ? `\n\nTitle hint from share source: ${params.title}`
    : '';
  return `${head}${titleHint}\n\n---\n\n${params.content}`;
}

/**
 * Generate a vault-safe filename for a captured note. Strips path
 * separators + `..` (defense in depth against malformed titles
 * coming from Apple Shortcuts). Falls back to a timestamp when the
 * title yields nothing slug-worthy.
 */
export function captureFilename(
  captureFolder: string,
  title: string | null,
  now: Date = new Date(),
): string {
  const dateStr = now.toISOString().slice(0, 10);
  const slug = slugify(title ?? '', 40) ||
    'capture-' + now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const folder = captureFolder.replace(/\/$/, '');
  return folder ? `${folder}/${dateStr}-${slug}.md` : `${dateStr}-${slug}.md`;
}

function slugify(text: string, max = 40): string {
  // Replace path separators + `..` with whitespace BEFORE the
  // character-class strip so a title like "foo/../bar" yields
  // "foo-bar" rather than collapsing to "foobar". Defense in depth
  // against malformed titles from Apple Shortcuts.
  return text
    .toLowerCase()
    .replace(/\.\.+/g, ' ')
    .replace(/[/\\]+/g, ' ')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

function safeAtob(s: string): string {
  try {
    // atob returns a binary string (each char = one byte). Re-
    // interpret as UTF-8 so multi-byte chars (é, em-dash, emoji)
    // come back correctly. Without this, "éclair" round-trips to
    // mojibake.
    const binary = atob(s);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface CaptureServiceConfig {
  workerUrl: string;
  workerToken: string;
  captureFolder: string;
  /** Vault-relative path of a prompt-template note. Empty → use
   * the kind-default prompt baked into this module. */
  promptPath: string;
}

export class CaptureService {
  constructor(
    private readonly app: App,
    private readonly cfg: () => CaptureServiceConfig,
  ) {}

  async handleProtocol(data: ObsidianProtocolData): Promise<void> {
    const params = parseCaptureParams(data);
    if (!params) {
      new Notice('scribian: capture had no content to process.');
      return;
    }
    const progress = new Notice('scribian: capturing…', 0);
    try {
      const note = await this.run(params);
      progress.hide();
      new Notice(`scribian: captured → ${note.path}`, 5000);
      if (!params.silent) {
        await this.app.workspace.openLinkText(note.path, '', false);
      }
    } catch (err) {
      progress.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`scribian: capture failed — ${msg}`, 8000);
    }
  }

  /** Run a capture end-to-end: prompt → /capture → vault write.
   * Returns the path that was written. Exposed for testing /
   * future programmatic capture sources (browser extension). */
  async run(params: CaptureParams): Promise<{ path: string }> {
    const cfg = this.cfg();
    if (!cfg.workerUrl || !cfg.workerToken) {
      throw new Error('Worker URL + token must be configured first.');
    }
    const customPromptBody = await this.readPromptTemplate(cfg.promptPath);
    const prompt = buildCapturePrompt(params, customPromptBody);

    const reqParams: RequestUrlParam = {
      url: `${cfg.workerUrl.replace(/^ws/, 'http').replace(/\/$/, '')}/capture`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.workerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt, kind: params.kind }),
      throw: false,
    };
    const resp = await requestUrl(reqParams);
    if (resp.status >= 400) {
      throw new Error(
        `/capture returned ${resp.status}: ${resp.text.slice(0, 300)}`,
      );
    }
    const body = resp.json as { body?: string; title?: string };
    if (!body.body) {
      throw new Error('/capture response missing body');
    }

    await this.ensureFolder(cfg.captureFolder);
    const filename = captureFilename(
      cfg.captureFolder,
      body.title ?? params.title ?? null,
    );
    const path = normalizePath(filename);
    await this.app.vault.create(path, body.body);
    return { path };
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
