import { describe, expect, it } from 'vitest';
import {
  buildCapturePrompt,
  captureFilename,
  parseCaptureParams,
  type CaptureParams,
} from './capture';

describe('parseCaptureParams', () => {
  it('returns null when payload is missing', () => {
    expect(parseCaptureParams({ action: 'skald-capture' })).toBeNull();
  });

  it('returns null when payload is empty', () => {
    expect(
      parseCaptureParams({ action: 'skald-capture', payload: '' }),
    ).toBeNull();
  });

  it('takes a shared URL as plain text from a URL-encoded payload', () => {
    const out = parseCaptureParams({
      action: 'skald-capture',
      payload: encodeURIComponent('https://example.com/foo?bar=baz'),
    });
    expect(out).toEqual<CaptureParams>({
      content: 'https://example.com/foo?bar=baz',
      title: undefined,
      silent: false,
    });
  });

  it('decodes a base64-encoded payload when b64=true', () => {
    const original = 'Hello — éclair!\nLine 2';
    const encoded = btoa(unescape(encodeURIComponent(original))); // utf-8 safe btoa
    const out = parseCaptureParams({
      action: 'skald-capture',
      kind: 'text',
      payload: encoded,
      b64: 'true',
    });
    // btoa/atob is byte-level; the encoded form preserves utf-8.
    expect(out?.content).toBe(original);
  });

  it('preserves the title hint and silent flag', () => {
    const out = parseCaptureParams({
      action: 'skald-capture',
      payload: encodeURIComponent('https://example.com'),
      title: 'Example dot com',
      silent: 'true',
    });
    expect(out?.title).toBe('Example dot com');
    expect(out?.silent).toBe(true);
  });
});

describe('buildCapturePrompt', () => {
  const base: CaptureParams = {
    content: 'A snippet of shared text.',
    silent: false,
  };

  it('uses the default prompt when no custom prompt is given', () => {
    const out = buildCapturePrompt(base, null);
    expect(out).toContain('shared this text from their phone');
    expect(out).toContain('A snippet of shared text.');
    expect(out.indexOf('shared this text')).toBeLessThan(
      out.indexOf('A snippet of shared text.'),
    );
  });

  it('uses a custom prompt body when provided (overrides the default)', () => {
    const out = buildCapturePrompt(base, 'CUSTOM PROMPT INSTRUCTIONS.');
    expect(out.startsWith('CUSTOM PROMPT INSTRUCTIONS.')).toBe(true);
    expect(out).not.toContain('shared this text from their phone');
  });

  it('appends the title hint when present', () => {
    const out = buildCapturePrompt(
      { ...base, title: 'A great article' },
      null,
    );
    expect(out).toContain('Title hint from share source: A great article');
  });

  it('separates head + content with a horizontal rule', () => {
    const out = buildCapturePrompt(base, null);
    expect(out).toContain('\n\n---\n\n');
  });

  it('tells the model not to invent the content of a bare link', () => {
    const out = buildCapturePrompt(
      { content: 'https://example.com', silent: false },
      null,
    );
    expect(out).toContain('do not guess at what the page says');
    expect(out).not.toMatch(/image|PDF|Open it/);
  });
});

describe('captureFilename', () => {
  const fixedDate = new Date('2026-05-14T15:30:00Z');

  it('builds a YYYY-MM-DD-<slug>.md path inside the configured folder', () => {
    expect(
      captureFilename('Skald/Captures', 'A great article', fixedDate),
    ).toBe('Skald/Captures/2026-05-14-a-great-article.md');
  });

  it('strips path separators + .. from the title for the slug', () => {
    expect(
      captureFilename(
        'Captures',
        'malicious/../path traversal',
        fixedDate,
      ),
    ).toBe('Captures/2026-05-14-malicious-path-traversal.md');
  });

  it('falls back to a timestamp slug when title is null', () => {
    const f = captureFilename('Captures', null, fixedDate);
    expect(f.startsWith('Captures/2026-05-14-capture-2026-05-14')).toBe(true);
    expect(f.endsWith('.md')).toBe(true);
  });

  it('omits the folder prefix when captureFolder is empty', () => {
    expect(captureFilename('', 'A title', fixedDate)).toBe(
      '2026-05-14-a-title.md',
    );
  });

  it('trims a trailing slash on captureFolder', () => {
    expect(captureFilename('Captures/', 'X', fixedDate)).toBe(
      'Captures/2026-05-14-x.md',
    );
  });

  it('truncates very long titles to 40 chars', () => {
    const title = 'a-'.repeat(50); // 100 chars
    const f = captureFilename('Captures', title, fixedDate);
    const slug = f.replace('Captures/2026-05-14-', '').replace('.md', '');
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  // Fix 3: collision uniquification via withTime flag
  it('appends the HH-MM-SS time suffix when withTime=true', () => {
    // Same date and title as the standard path; withTime=true adds the time
    // component so same-day same-slug collisions get a distinct filename.
    const f = captureFilename('Skald/Captures', 'A great article', fixedDate, true);
    // Should still start with date and base slug.
    expect(f).toContain('2026-05-14-a-great-article');
    // Must contain the time component derived from the ISO string (15:30:00Z → 15-30-00).
    expect(f).toContain('15-30-00');
    expect(f.endsWith('.md')).toBe(true);
  });

  it('withTime=false (default) omits the time suffix', () => {
    const withoutTime = captureFilename('Captures', 'test', fixedDate, false);
    const withTime = captureFilename('Captures', 'test', fixedDate, true);
    expect(withTime).not.toBe(withoutTime);
    // The non-time version must not include the time component.
    expect(withoutTime).not.toContain('15-30-00');
  });
});
