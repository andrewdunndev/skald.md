/**
 * Release invariant tests.
 *
 * These tests catch drift between the build artefacts, the versions
 * registry, and the user-facing docs — things that are invisible at
 * TypeScript compile time but break Obsidian's update pipeline and
 * confuse first-time installers.
 *
 * Every assertion here directly corresponds to a documented bug
 * (see campaigns/scribian/notes/prelaunch-audit-2026-06-20.md):
 *
 *  (A) manifest.version must be present in versions.json so Obsidian
 *      knows which minimum app version applies. The release workflow
 *      also guards tag == manifest version — this test catches the
 *      artefact-level half. Uses the root manifest.json (committed) as
 *      the canonical source; the dist/manifest.json is checked when
 *      present (after a build).
 *
 *  (B) README quick-start copy must list all four dist files so a
 *      fresh install works without reading installing-the-plugin.md.
 *
 *  (C) The manual-build steps must cd into the real clone directory
 *      (skald.md, not skald) so the command sequence runs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve relative to the repo root (three levels up from packages/plugin/src/).
const root = resolve(__dirname, '../../../');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as Record<string, unknown>;
}

function readText(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

const distManifestPath = resolve(root, 'packages/plugin/dist/manifest.json');
const distExists = existsSync(distManifestPath);

describe('release invariants', () => {
  it('(A) root manifest.json version exists as a key in versions.json', () => {
    const manifest = readJson('manifest.json');
    const versions = readJson('versions.json');

    const pluginVersion = manifest['version'] as string;
    expect(typeof pluginVersion).toBe('string');
    expect(pluginVersion.length).toBeGreaterThan(0);

    // Every shipped version must have a minAppVersion entry in versions.json so
    // Obsidian knows whether the running app can load this plugin.
    expect(Object.keys(versions)).toContain(pluginVersion);
  });

  it('(A) dist/manifest.json version matches root manifest.json when built', () => {
    if (!distExists) {
      // Skip silently when dist/ has not been built yet (clean worktree).
      // The release workflow always builds before publishing, so the CI gate
      // catches any mismatch; this test validates the local-build path.
      return;
    }
    const rootManifest = readJson('manifest.json');
    const distManifest = readJson('packages/plugin/dist/manifest.json');
    expect(distManifest['version']).toBe(rootManifest['version']);
  });

  it('(B) README quick-start mentions versions.json in the copy-files list', () => {
    const readme = readText('README.md');
    // The install snippet must include all four release assets so that users
    // copying the command get a fully functional plugin, not a partial install.
    expect(readme).toContain('versions.json');
  });

  it('(C) installing-the-plugin.md uses the correct clone directory name', () => {
    const doc = readText('docs/installing-the-plugin.md');
    // `git clone https://gitlab.com/dunn.dev/skald.md.git` produces a
    // directory named skald.md, not skald. The cd must match.
    expect(doc).toContain('cd skald.md');
    expect(doc).not.toMatch(/cd skald\n/);
  });
});
