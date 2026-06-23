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
 * for the current pass list themselves in `DEVIATIONS.md` with a
 * hard expiration date. An expired deviation fails the check; the
 * register cannot become a permanent escape hatch.
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
 * Files explicitly granted a temporary exception, each with a hard
 * expiration. After the date passes, the check will fail with a
 * prescriptive failure pointing at this list. Keep in sync with
 * `DEVIATIONS.md` — when one entry resolves (the file gets
 * refactored under cap), remove from both.
 */
const DEVIATIONS = [
  {
    file: 'packages/plugin/src/view.ts',
    cap: 425,
    expires: '2026-09-22',
    note: 'a11y + scroll-guard additions pushed past 400; extract setStatus + status-row setup to view/status-row.ts',
  },
  {
    file: 'packages/plugin/src/view/message-list.ts',
    cap: 450,
    expires: '2026-09-22',
    note: 'scroll-guard (isNearBottom + scrollToBottom + pendingForceScroll) grew the file; extract scroll-guard logic to view/scroll-guard.ts when the refactor window opens',
  },
  {
    file: 'packages/plugin/src/chat-session.ts',
    cap: 415,
    expires: '2026-09-22',
    note: 'MAX_TOOL_LEGS cap (security fix) added toolLegCount + cap guard; extract agentic-loop logic to chat-session-tool-loop.ts',
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

function expiredDeviationFor(rel) {
  const dev = DEVIATIONS.find((d) => d.file === rel);
  if (!dev) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (today > dev.expires) {
    return { ...dev, expired: true };
  }
  return { ...dev, expired: false };
}

const sources = (
  await Promise.all(SOURCE_ROOTS.map((r) => walk(path.join(ROOT, r))))
).flat();

const findings = [];
for (const abs of sources) {
  const rel = path.relative(ROOT, abs);
  const lines = await lineCount(abs);
  const dev = expiredDeviationFor(rel);
  const effectiveCap = dev && !dev.expired ? dev.cap : CAP;
  if (lines > effectiveCap) {
    findings.push({ rel, lines, effectiveCap, dev });
  } else if (dev && !dev.expired && lines <= CAP) {
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
  if (f.dev?.expired) {
    console.log(
      `EXPIRED-DEVIATION ${f.rel}: ${f.lines} lines exceeds cap ${CAP}; deviation expired ${f.dev.expires}. Refactor: ${f.dev.note}`,
    );
    fail++;
    continue;
  }
  console.log(
    `OVER-CAP ${f.rel}: ${f.lines} lines > ${f.effectiveCap}. ` +
      `Refactor by extracting a module with a single named responsibility. ` +
      `If a temporary exception is justified, add an entry to DEVIATIONS list ` +
      `in scripts/check-size.mjs and DEVIATIONS.md with a hard expiration.`,
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
