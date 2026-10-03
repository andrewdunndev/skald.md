import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'));

const manifest = read('../../../manifest.json');

describe('release manifest', () => {
  it('package versions equal the manifest version', () => {
    expect(read('../../../package.json').version).toBe(manifest.version);
    expect(read('../package.json').version).toBe(manifest.version);
  });

  it('versions.json maps the manifest version to its minAppVersion', () => {
    expect(read('../../../versions.json')[manifest.version]).toBe(
      manifest.minAppVersion,
    );
  });

  it('ships to mobile', () => {
    expect(manifest.isDesktopOnly).toBe(false);
  });
});
