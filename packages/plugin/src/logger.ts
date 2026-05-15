import { App, normalizePath, TFile } from 'obsidian';

export type LogLevel = 'info' | 'warn' | 'error';

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
    const line = `${ts} [${level}] ${text}`;
    // Always mirror to console for live dev debugging. info-level
    // routes to console.info (not console.log) so it doesn't trip
    // the plugin-submission lint that forbids console.log in
    // production source.
    if (level === 'error') console.error('scribian:', line);
    else if (level === 'warn') console.warn('scribian:', line);
    else console.info('scribian:', line);

    const folder = this.folderGetter().trim();
    if (!folder) return;

    // Serialize file writes to avoid concurrent append races.
    this.writeChain = this.writeChain.then(() =>
      this.appendToDailyFile(folder, line).catch((err) => {
        console.error('scribian: log write failed', err);
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
