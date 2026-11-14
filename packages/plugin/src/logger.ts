import { App, normalizePath, TFile } from 'obsidian';

export type LogLevel = 'info' | 'warn' | 'error';

const REDACTED = '«redacted»';

/**
 * Names of fields whose values are secrets and must never reach a log.
 * Matched case-insensitively, allowing common separators (apiKey,
 * api_key, api-key, "api key").
 */
const SECRET_KEY_PATTERN =
  'api[-_ ]?key|authorization|auth[-_ ]?token|access[-_ ]?token|' +
  'refresh[-_ ]?token|secret|password|passwd|bearer|x-api-key';

/**
 * Redact secrets from a log line before it is written anywhere
 * (console or vault file). Defends against accidentally logging an
 * object that carries an API key or a header that carries a token.
 *
 * Three passes, all on the already-stringified line:
 *  1. JSON-style fields:  "apiKey":"sk-…"  ->  "apiKey":"«redacted»"
 *  2. assignment style:   apiKey=sk-… / authorization: Bearer sk-…
 *  3. bare Bearer tokens: Bearer sk-…      ->  Bearer «redacted»
 *
 * The patterns are intentionally broad: it is always safe to
 * over-redact a log line, never safe to leak a key.
 */
export function redactSecrets(line: string): string {
  let out = line;
  // 1. JSON object fields: "key":"value" or "key": "value" (handles
  //    escaped quotes inside the value).
  out = out.replace(
    new RegExp(`("(?:${SECRET_KEY_PATTERN})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
    `$1"${REDACTED}"`,
  );
  // 2. key=value / key: value (unquoted, up to whitespace/comma/brace).
  out = out.replace(
    new RegExp(`\\b(${SECRET_KEY_PATTERN})(\\s*[:=]\\s*)(?:Bearer\\s+)?[^\\s,}"']+`, 'gi'),
    `$1$2${REDACTED}`,
  );
  // 3. Any remaining "Bearer <token>" form.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`);
  return out;
}

/**
 * Append-only plugin logger that writes to a daily file in the
 * configured logs folder, plus mirrors to the browser console for
 * dev tooling. Set folder to empty to disable file logging.
 *
 * Format: `YYYY-MM-DD-HH:mm:ss [level] message`. Each line writes
 * atomically via vault.append; concurrent writes are serialized
 * through a single Promise chain to avoid file races.
 */
export class Logger {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private folderGetter: () => string,
  ) {}

  info(...parts: unknown[]): void {
    this.write('info', parts);
  }
  warn(...parts: unknown[]): void {
    this.write('warn', parts);
  }
  error(...parts: unknown[]): void {
    this.write('error', parts);
  }

  private write(level: LogLevel, parts: unknown[]): void {
    const text = parts
      .map((p) =>
        typeof p === 'string' ? p : p instanceof Error ? p.message : JSON.stringify(p),
      )
      .join(' ');
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // Redact secrets before the line touches console or vault file.
    const line = redactSecrets(`${ts} [${level}] ${text}`);
    if (level === 'error') console.error('skald:', line);

    const folder = this.folderGetter().trim();
    if (!folder) return;

    // Serialize file writes to avoid concurrent append races.
    this.writeChain = this.writeChain.then(() =>
      this.appendToDailyFile(folder, line).catch((err) => {
        console.error('skald: log write failed', err);
      }),
    );
  }

  private async appendToDailyFile(folder: string, line: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const path = normalizePath(`${folder}/${day}.log`);

    const folderItem = this.app.vault.getAbstractFileByPath(normalizePath(folder));
    if (!folderItem) {
      await this.app.vault.createFolder(normalizePath(folder));
    }

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, line + '\n');
    } else {
      await this.app.vault.create(path, line + '\n');
    }
  }
}
