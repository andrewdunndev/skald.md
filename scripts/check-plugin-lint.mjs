#!/usr/bin/env node
/**
 * Pre-submission lint for the Obsidian plugin. Enforces the
 * community-plugin guidelines that skald needs to clear before
 * the developer-dashboard submission (and that catch real bugs
 * regardless).
 *
 * Rules:
 *   - manifest.json + package.json versions agree (both for
 *     root + plugin workspace)
 *   - manifest.json declares `isDesktopOnly: false` (we ship to
 *     mobile)
 *   - No `console.log` in production source — only console.warn /
 *     console.error are allowed (logs go through Logger which
 *     handles vault file mirror). console.log() pollutes Obsidian's
 *     devtools for the user.
 *   - No `innerHTML` / `outerHTML` assignments — Obsidian's
 *     guidelines require DOM-API construction (createDiv/createEl/
 *     setText). Writes only; reads are fine.
 *   - No `document.evaluate` (XPath) — Obsidian flagged as unstable
 *
 * Designed to be cheap (regex over source files) so it runs in CI
 * without serious dependencies. Findings include line numbers.
 *
 * Files under .test.ts / .snapshot.test.ts / scripts/ are skipped
 * (tests + tooling are allowed to use console.log for
 * troubleshooting).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const SCAN_ROOTS = ['packages/plugin/src'];

const findings = [];
function fail(rule, file, lineNo, line) {
  findings.push({ rule, file, lineNo, line: line.trim().slice(0, 120) });
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(p)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    if (entry.name.endsWith('.snapshot.test.ts')) continue;
    out.push(p);
  }
  return out;
}

async function checkVersionParity() {
  const manifestPath = path.join(ROOT, 'packages/plugin/manifest.json');
  const pkgPath = path.join(ROOT, 'packages/plugin/package.json');
  const rootPkgPath = path.join(ROOT, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
  const rootPkg = JSON.parse(await fs.readFile(rootPkgPath, 'utf-8'));
  if (manifest.version !== pkg.version) {
    findings.push({
      rule: 'version-parity',
      file: 'packages/plugin',
      lineNo: 0,
      line: `manifest.version=${manifest.version} !== package.version=${pkg.version}`,
    });
  }
  if (rootPkg.version && rootPkg.version !== manifest.version) {
    findings.push({
      rule: 'version-parity',
      file: 'root',
      lineNo: 0,
      line: `root package.version=${rootPkg.version} !== plugin manifest.version=${manifest.version}`,
    });
  }
  if (manifest.isDesktopOnly !== false) {
    findings.push({
      rule: 'mobile-flag',
      file: 'packages/plugin/manifest.json',
      lineNo: 0,
      line: `expected "isDesktopOnly": false (got ${JSON.stringify(manifest.isDesktopOnly)})`,
    });
  }
}

async function checkSourceFile(absPath) {
  const rel = path.relative(ROOT, absPath);
  const body = await fs.readFile(absPath, 'utf-8');
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    // Skip commented-out lines (a leading // or * is enough to
    // ignore for these heuristics — false negatives are fine, we
    // want low false-positive noise).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    if (/\bconsole\.log\s*\(/.test(line)) {
      fail('no-console-log', rel, lineNo, line);
    }
    if (/\.(innerHTML|outerHTML)\s*=/.test(line)) {
      fail('no-innerHTML-write', rel, lineNo, line);
    }
    if (/document\.evaluate\s*\(/.test(line)) {
      fail('no-document-evaluate', rel, lineNo, line);
    }
  }
}

await checkVersionParity();
const sources = (
  await Promise.all(SCAN_ROOTS.map((r) => walk(path.join(ROOT, r))))
).flat();
for (const f of sources) await checkSourceFile(f);

const RULE_HELP = {
  'no-console-log':
    'console.log pollutes the user\'s Obsidian devtools. Use the Logger module (mirrors to a vault file + console.warn/error) for any output the user might need to see.',
  'no-innerHTML-write':
    'Obsidian community-plugin guidelines forbid innerHTML/outerHTML writes (XSS surface). Use createDiv/createEl/setText/setIcon instead.',
  'no-document-evaluate':
    'document.evaluate (XPath) is flagged unstable; query via querySelector/querySelectorAll instead.',
  'version-parity':
    'manifest.json + package.json versions must match before community-plugin submission.',
  'mobile-flag':
    'manifest.json must declare isDesktopOnly: false for a plugin that ships to iOS/iPad.',
};

if (findings.length === 0) {
  console.log(
    `OK: ${sources.length} TS source files inspected, no plugin-submission lint violations.`,
  );
  process.exit(0);
}

for (const f of findings) {
  console.log(`${f.rule.toUpperCase()}  ${f.file}:${f.lineNo}  ${f.line}`);
}
console.log('');
const distinctRules = [...new Set(findings.map((f) => f.rule))];
for (const r of distinctRules) {
  console.log(`  - ${r}: ${RULE_HELP[r] ?? '(no help text)'}`);
}
console.log(`\nFAIL: ${findings.length} plugin-submission lint violation(s).`);
process.exit(1);
