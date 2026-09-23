#!/usr/bin/env node
/**
 * File-size check for the skald workspace.
 *
 * Rationale: small modules keep the surface an LLM (or a reviewer)
 * has to scan small. The yotoshelf project landed on 250 LOC for Go,
 * 400 for TypeScript as the threshold where modules start hiding too
 * much. Adopting 400 LOC for skald's TS workspace.
 *
 * What this counts: total lines (including comments + blanks). Total
 * is the most honest measure of "how much do I have to scroll
 * through" — and large doc blocks DO take cognitive load when
 * scanning a file. The right escape valve for long docs is dedicated
 * markdown files in docs/, not 200-line JSDoc preambles inside the
 * module.
 *
 * Tests are capped at the same 400 — if a test file outgrows the
 * limit, the right move is usually to split the source module (and
 * the tests follow it) or split into `<module>.<scenario>.test.ts`
 * siblings for distinct behavioral surfaces.
 *
 * Deviations: files that exceed the cap and aren't a refactor target
 * for the current pass list themselves in `DEVIATIONS.md` with the
 * override cap and a one-line "next move." The entry stands until
 * the refactor lands and it's removed from both files.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const CAP = 400;
const SOURCE_ROOTS = [
  'packages/plugin/src',
  'packages/protocol/src',
];

/**
 * Files explicitly granted an exception, each with a raised cap and
 * a one-line "next move." Keep in sync with `DEVIATIONS.md` — when
 * one entry resolves (the file gets refactored under cap), remove
 * from both.
 */
const DEVIATIONS = [
  {
    file: 'packages/plugin/src/view.ts',
    cap: 425,
    note: 'a11y + scroll-guard additions pushed past 400; extract setStatus + status-row setup to view/status-row.ts',
  },
  {
    file: 'packages/plugin/src/view/message-list.ts',
    cap: 450,
    note: 'scroll-guard (isNearBottom + scrollToBottom + pendingForceScroll) grew the file; extract scroll-guard logic to view/scroll-guard.ts when the refactor window opens',
  },
];

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
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

async function lineCount(p) {
  const body = await fs.readFile(p, 'utf-8');
  // Trailing newline shouldn't count as an extra empty line.
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
  return trimmed.split('\n').length;
}

function deviationFor(rel) {
  return DEVIATIONS.find((d) => d.file === rel) ?? null;
}

const sources = (
  await Promise.all(SOURCE_ROOTS.map((r) => walk(path.join(ROOT, r))))
).flat();

const findings = [];
for (const abs of sources) {
  const rel = path.relative(ROOT, abs);
  const lines = await lineCount(abs);
  const dev = deviationFor(rel);
  const effectiveCap = dev ? dev.cap : CAP;
  if (lines > effectiveCap) {
    findings.push({ rel, lines, effectiveCap, dev });
  } else if (dev && lines <= CAP) {
    // File is now under the global cap; the deviation entry is
    // stale and should be removed.
    findings.push({
      rel,
      lines,
      effectiveCap: CAP,
      dev,
      staleDeviation: true,
    });
  }
}

let fail = 0;
for (const f of findings) {
  if (f.staleDeviation) {
    console.log(
      `STALE-DEVIATION ${f.rel} (${f.lines} lines, cap ${CAP}). Remove deviation from scripts/check-size.mjs.`,
    );
    fail++;
    continue;
  }
  console.log(
    `OVER-CAP ${f.rel}: ${f.lines} lines > ${f.effectiveCap}. ` +
      `Refactor by extracting a module with a single named responsibility. ` +
      `If an exception is justified, add an entry to the DEVIATIONS list ` +
      `in scripts/check-size.mjs and DEVIATIONS.md with a raised cap and a next move.`,
  );
  fail++;
}

if (fail > 0) {
  console.log(`\nFAIL: ${fail} file-size violation(s). Cap is ${CAP} lines.`);
  process.exit(1);
}

console.log(
  `OK: ${sources.length} TS source files inspected, all under the ${CAP}-line cap (or within a deviation).`,
);
