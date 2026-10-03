import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { Logger, redactSecrets } from './logger';

describe('redactSecrets', () => {
  it('redacts a JSON apiKey field', () => {
    const out = redactSecrets('config {"apiKey":"sk-ant-abc123secret"}');
    expect(out).not.toContain('sk-ant-abc123secret');
    expect(out).toContain('«redacted»');
  });

  it('redacts api_key / api-key / "api key" spelling variants', () => {
    expect(redactSecrets('api_key=sk-live-1')).not.toContain('sk-live-1');
    expect(redactSecrets('api-key: sk-live-2')).not.toContain('sk-live-2');
    expect(redactSecrets('"api key":"sk-live-3"')).not.toContain('sk-live-3');
  });

  it('redacts an Authorization header carrying a Bearer token', () => {
    const out = redactSecrets('headers {"authorization":"Bearer sk-secret-xyz"}');
    expect(out).not.toContain('sk-secret-xyz');
  });

  it('redacts a bare Bearer token anywhere in the line', () => {
    const out = redactSecrets('GET /v1 -> Bearer sk-or-deadbeefcafe');
    expect(out).not.toContain('sk-or-deadbeefcafe');
    expect(out).toContain('Bearer «redacted»');
  });

  it('leaves non-secret content alone', () => {
    const line = '2026-06-22 12:00:00 [info] request to https://api.anthropic.com ok';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('Logger.write redaction', () => {
  let appended: string[];
  let app: App;

  beforeEach(() => {
    appended = [];
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const fileObj = { path: '' };
    app = {
      vault: {
        getAbstractFileByPath: (p: string) =>
          p.endsWith('.log') ? fileObj : { path: p },
        createFolder: () => Promise.resolve(),
        append: (_f: unknown, data: string) => {
          appended.push(data);
          return Promise.resolve();
        },
        create: (_p: string, data: string) => {
          appended.push(data);
          return Promise.resolve();
        },
      },
    } as unknown as App;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a Bearer token never reaches the console mirror or the vault file', async () => {
    const logger = new Logger(app, () => 'Logs');
    logger.info('dispatch', { authorization: 'Bearer sk-ant-supersecret-99' });

    // Flush the serialized write chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const consoleCall = (console.debug as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.map((c) => c.join(' '))
      .join('\n');
    expect(consoleCall).not.toContain('sk-ant-supersecret-99');

    const written = appended.join('');
    expect(written).not.toContain('sk-ant-supersecret-99');
    expect(written).toContain('«redacted»');
  });

  it('an apiKey value never reaches the vault file', async () => {
    const logger = new Logger(app, () => 'Logs');
    logger.error('boom', { apiKey: 'sk-or-leakme-1234' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(appended.join('')).not.toContain('sk-or-leakme-1234');
  });
});
