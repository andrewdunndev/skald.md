/**
 * iOS share-sheet + URL-scheme capture (phase 8).
 *
 * Trigger: `obsidian://scribian-capture?...` (fired by an Apple
 * Shortcut). Flow: parseCaptureParams → CaptureService.run() →
 * POST /capture on the Worker → routeCapture picks destination
 * (auto-route via vault.process to matched note, or create in
 * captureFolder).
 *
 * Privacy posture: transient pipe. Worker holds nothing
 * post-response. Same trust as the chat path. Rate-limited at
 * the handler level — see CAPTURE_RATE_LIMIT_COUNT.
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
import { searchVault, type MemoryClientConfig, type SearchHit } from './memory-client';
import { SlidingWindow } from './rate-limit';
import {
  captureFilename,
  safeAtob,
  safeDecodeURIComponent,
} from './capture-util';

export { captureFilename } from './capture-util';

export type CaptureKind = 'url' | 'text' | 'image' | 'pdf';

export type CaptureMode = 'auto-route' | 'inbox';

/** Min similarity score for routing a capture to an existing note.
 *  Below this, the capture falls back to creating in captureFolder.
 *
 *  Tuned to 0.85: high enough that a malicious capture URI can't
 *  easily target an existing user note (would require attacker
 *  knowledge of vault content AND a payload that embeds close to
 *  it), low enough that genuinely-related captures route correctly.
 *
 *  Lower threshold (0.7) was the initial heuristic; raised after
 *  the security audit identified malicious-URI append as a real
 *  risk surface. False negatives (route to inbox when an append
 *  would've been better) are recoverable by the user; false
 *  positives (silent append to a wrong note) are not.
 */
export const CAPTURE_ROUTE_THRESHOLD = 0.85;

export interface CaptureRoute {
  kind: 'create' | 'append';
  path: string;
  /** Score of the matched note when kind='append'; absent when
   *  kind='create'. */
  matchScore?: number;
  /** Top candidates considered, for telemetry / a future "change
   *  destination" picker. Empty when search wasn't run (inbox mode
   *  or search unavailable). */
  candidates: Array<{ path: string; score: number }>;
}

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

// captureFilename + slugify + safeAtob + safeDecodeURIComponent
// live in ./capture-util.ts so this file stays focused on the
// CaptureService orchestration.

export interface CaptureServiceConfig {
  workerUrl: string;
  workerToken: string;
  captureFolder: string;
  /** Vault-relative path of a prompt-template note. Empty → use
   * the kind-default prompt baked into this module. */
  promptPath: string;
  /** 'auto-route' runs find_related on the generated note + appends
   * to the top match when score >= CAPTURE_ROUTE_THRESHOLD. 'inbox'
   * always creates in captureFolder. Default is 'auto-route' —
   * intelligent triage is scribian's value-add over Obsidian's
   * native share-sheet handler. */
  mode: CaptureMode;
}

/**
 * Decide where a captured note should land. Pure routing logic over
 * a searcher callback so the caller can inject either the real
 * /search HTTP path or a stub. Score threshold is the safety knob —
 * below the threshold the capture goes to inbox regardless of mode.
 *
 * Search failures are treated as "no match found" (falls back to
 * create-in-inbox); the caller decides whether to surface the
 * failure to the user via a Notice.
 */
export async function routeCapture(
  searcher: (query: string, topK: number) => Promise<SearchHit[]>,
  options: {
    mode: CaptureMode;
    title: string;
    body: string;
    captureFolder: string;
    threshold?: number;
  },
): Promise<CaptureRoute> {
  const threshold = options.threshold ?? CAPTURE_ROUTE_THRESHOLD;
  if (options.mode !== 'auto-route') {
    return {
      kind: 'create',
      path: captureFilename(options.captureFolder, options.title),
      candidates: [],
    };
  }
  // Title carries the topical handle; body excerpt grounds it. Cap
  // body at 500 chars so the embedding model has signal without
  // ballooning the query.
  const query = `${options.title}\n\n${options.body.slice(0, 500)}`;
  let hits: SearchHit[] = [];
  try {
    hits = await searcher(query, 3);
  } catch {
    hits = [];
  }
  const candidates = hits.map((h) => ({ path: h.path, score: h.score }));
  const top = hits[0];
  if (top && top.score >= threshold) {
    return {
      kind: 'append',
      path: top.path,
      matchScore: top.score,
      candidates,
    };
  }
  return {
    kind: 'create',
    path: captureFilename(options.captureFolder, options.title),
    candidates,
  };
}

/** Rate limit on the capture protocol handler. The handler can be
 * fired by ANY page that crafts an `obsidian://scribian-capture`
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
      new Notice('scribian: capture had no content to process.');
      return;
    }
    if (this.limiter.isExceeded()) {
      new Notice(
        `scribian: capture rate-limit hit (${CAPTURE_RATE_LIMIT_COUNT}/min). If this is unexpected, a webpage may be firing capture URLs — check what's open.`,
        10_000,
      );
      console.warn(
        `scribian: capture rejected by rate-limit (${this.limiter.size()} in ${CAPTURE_RATE_LIMIT_WINDOW_MS / 1000}s window)`,
      );
      return;
    }
    this.limiter.record();
    const progress = new Notice('scribian: capturing…', 0);
    try {
      const note = await this.run(params);
      progress.hide();
      const verb = note.routedTo === 'append' ? 'routed to' : 'captured';
      new Notice(`scribian: ${verb} → ${note.path}`, 5000);
      if (!params.silent) {
        await this.app.workspace.openLinkText(note.path, '', false);
      }
    } catch (err) {
      progress.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`scribian: capture failed — ${msg}`, 8000);
    }
  }

  /** Run a capture end-to-end: prompt → /capture → routing → vault
   * write. Returns the resolved path + whether it created or appended.
   * Exposed for testing / future programmatic capture sources
   * (browser extension). */
  async run(
    params: CaptureParams,
  ): Promise<{ path: string; routedTo: 'create' | 'append' }> {
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

    const memoryClient: MemoryClientConfig = {
      workerUrl: cfg.workerUrl,
      workerToken: cfg.workerToken,
    };
    const route = await routeCapture(
      (q, k) => searchVault(memoryClient, q, k),
      {
        mode: cfg.mode,
        title: body.title ?? params.title ?? '',
        body: body.body,
        captureFolder: cfg.captureFolder,
      },
    );

    if (route.kind === 'append') {
      const path = normalizePath(route.path);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        // vault.process applies the transform atomically against
        // whatever's on disk at the moment of write — safer than
        // read-then-modify when the user has the target note open
        // in another editor pane with unsaved edits.
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        await this.app.vault.process(existing, (current) => {
          const sep = current.endsWith('\n') ? '\n' : '\n\n';
          return `${current}${sep}---\n\nCaptured ${stamp}\n\n${body.body}`;
        });
        return { path, routedTo: 'append' };
      }
      // Target vanished between search and write — fall back to create.
    }

    await this.ensureFolder(cfg.captureFolder);
    const filename = captureFilename(
      cfg.captureFolder,
      body.title ?? params.title ?? null,
    );
    const path = normalizePath(filename);
    await this.app.vault.create(path, body.body);
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
