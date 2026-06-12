import { describe, expect, it } from 'vitest';
import {
  buildCapturePrompt,
  captureFilename,
  parseCaptureParams,
  routeCapture,
  type CaptureParams,
} from './capture';
import type { SearchHit } from './memory-client';

describe('parseCaptureParams', () => {
  it('returns null when payload is missing', () => {
    expect(parseCaptureParams({ action: 'scribian-capture' })).toBeNull();
  });

  it('returns null when payload is empty', () => {
    expect(
      parseCaptureParams({ action: 'scribian-capture', payload: '' }),
    ).toBeNull();
  });

  it('parses a URL kind with a URL-encoded payload', () => {
    const out = parseCaptureParams({
      action: 'scribian-capture',
      kind: 'url',
      payload: encodeURIComponent('https://example.com/foo?bar=baz'),
    });
    expect(out).toEqual<CaptureParams>({
      kind: 'url',
      content: 'https://example.com/foo?bar=baz',
      title: undefined,
      prompt: undefined,
      silent: false,
    });
  });

  it('decodes a base64-encoded payload when b64=true', () => {
    const original = 'Hello — éclair!\nLine 2';
    const encoded = btoa(unescape(encodeURIComponent(original))); // utf-8 safe btoa
    const out = parseCaptureParams({
      action: 'scribian-capture',
      kind: 'text',
      payload: encoded,
      b64: 'true',
    });
    // btoa/atob is byte-level; the encoded form preserves utf-8.
    expect(out?.content).toBe(original);
    expect(out?.kind).toBe('text');
  });

  it('defaults kind to "text" when unrecognized', () => {
    const out = parseCaptureParams({
      action: 'scribian-capture',
      kind: 'mystery-kind',
      payload: 'hi',
    });
    expect(out?.kind).toBe('text');
  });

  it('preserves title + prompt hints + silent flag', () => {
    const out = parseCaptureParams({
      action: 'scribian-capture',
      kind: 'url',
      payload: encodeURIComponent('https://example.com'),
      title: 'Example dot com',
      prompt: 'Scribian/Prompts/url.md',
      silent: 'true',
    });
    expect(out?.title).toBe('Example dot com');
    expect(out?.prompt).toBe('Scribian/Prompts/url.md');
    expect(out?.silent).toBe(true);
  });
});

describe('buildCapturePrompt', () => {
  const base: CaptureParams = {
    kind: 'text',
    content: 'A snippet of shared text.',
    silent: false,
  };

  it('uses the kind-default prompt when no custom prompt is given', () => {
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

  it('selects the URL prompt for kind=url', () => {
    const out = buildCapturePrompt(
      { kind: 'url', content: 'https://example.com', silent: false },
      null,
    );
    expect(out).toContain('shared this URL');
  });

  it('selects the image prompt for kind=image', () => {
    const out = buildCapturePrompt(
      { kind: 'image', content: 'inbox/photo.png', silent: false },
      null,
    );
    expect(out).toContain('shared this image');
  });
});

describe('captureFilename', () => {
  const fixedDate = new Date('2026-05-14T15:30:00Z');

  it('builds a YYYY-MM-DD-<slug>.md path inside the configured folder', () => {
    expect(
      captureFilename('Scribian/Captures', 'A great article', fixedDate),
    ).toBe('Scribian/Captures/2026-05-14-a-great-article.md');
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
});

describe('routeCapture', () => {
  const hit = (path: string, score: number): SearchHit => ({
    path,
    title: path.replace(/\.md$/, ''),
    score,
    kind: 'note-summary',
  });

  it('returns inbox-create when mode is inbox', async () => {
    const route = await routeCapture(
      async () => [hit('Projects/Flowers.md', 0.95)],
      {
        mode: 'inbox',
        title: 'A tulip',
        body: 'red petals, six chambers',
        captureFolder: 'Scribian/Captures',
      },
    );
    expect(route.kind).toBe('create');
    expect(route.path).toMatch(/^Scribian\/Captures\//);
    expect(route.candidates).toEqual([]);
  });

  it('routes to the top hit when auto-route + score above threshold', async () => {
    const route = await routeCapture(
      async () => [hit('Projects/Flowers.md', 0.92)],
      {
        mode: 'auto-route',
        title: 'A tulip',
        body: 'red petals',
        captureFolder: 'Scribian/Captures',
      },
    );
    expect(route.kind).toBe('append');
    expect(route.path).toBe('Projects/Flowers.md');
    expect(route.matchScore).toBe(0.92);
    expect(route.candidates).toHaveLength(1);
  });

  it('falls back to inbox-create when top score below threshold (post-hardening: 0.85)', async () => {
    // Security audit raised the threshold from 0.7 to 0.85. A 0.8
    // match — which would have appended pre-hardening — now falls
    // back to inbox, reducing the malicious-URI-targets-existing-
    // note attack surface.
    const route = await routeCapture(
      async () => [hit('Random/Note.md', 0.8)],
      {
        mode: 'auto-route',
        title: 'A tulip',
        body: 'red petals',
        captureFolder: 'Scribian/Captures',
      },
    );
    expect(route.kind).toBe('create');
    expect(route.path).toMatch(/^Scribian\/Captures\//);
    expect(route.candidates).toHaveLength(1);
    expect(route.candidates[0].score).toBe(0.8);
  });

  it('falls back to inbox-create when search yields no hits', async () => {
    const route = await routeCapture(async () => [], {
      mode: 'auto-route',
      title: 'A tulip',
      body: 'red petals',
      captureFolder: 'Scribian/Captures',
    });
    expect(route.kind).toBe('create');
    expect(route.candidates).toEqual([]);
  });

  it('falls back to inbox-create when search throws', async () => {
    const route = await routeCapture(
      async () => {
        throw new Error('network down');
      },
      {
        mode: 'auto-route',
        title: 'A tulip',
        body: 'red petals',
        captureFolder: 'Scribian/Captures',
      },
    );
    expect(route.kind).toBe('create');
    expect(route.candidates).toEqual([]);
  });

  it('respects custom threshold override', async () => {
    // Top hit 0.6 — above the 0.5 override but below default 0.7.
    const route = await routeCapture(
      async () => [hit('Match.md', 0.6)],
      {
        mode: 'auto-route',
        title: 'X',
        body: 'Y',
        captureFolder: 'Scribian/Captures',
        threshold: 0.5,
      },
    );
    expect(route.kind).toBe('append');
    expect(route.matchScore).toBe(0.6);
  });

  it('caps body in query to 500 chars', async () => {
    const longBody = 'x'.repeat(5000);
    let received = '';
    await routeCapture(
      async (q) => {
        received = q;
        return [];
      },
      {
        mode: 'auto-route',
        title: 'long capture',
        body: longBody,
        captureFolder: 'Scribian/Captures',
      },
    );
    // Title + 2 newlines + ≤ 500 body chars
    expect(received.length).toBeLessThanOrEqual('long capture'.length + 2 + 500);
  });
});

