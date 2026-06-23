/**
 * Deterministic, on-device tool-result compaction.
 *
 * Shrinks large tool outputs BEFORE they hit the model context window,
 * replacing hard byte-truncation as the first line of defence.  The byte
 * cap (capResult / MAX_TOOL_RESULT_BYTES) remains the final backstop.
 *
 * Compaction is ALWAYS lossless or safe-degrading:
 *   - JSON → TOON  : structurally equivalent; the TOON is decoded back and
 *                    deep-equalled against the source before it is accepted.
 *                    Any mismatch falls through to minify (then unchanged).
 *   - JSON → minify: whitespace stripped, all values preserved; the minified
 *                    output is re-parsed and deep-equalled before acceptance.
 *   - Text dedup   : repeated identical lines collapsed with a marker.
 *   - Any error    : input returned unchanged (never throws, never corrupts).
 *
 * Integer-precision guard
 * ───────────────────────
 * `JSON.parse` silently rounds integer literals beyond ±2^53−1
 * (Number.MAX_SAFE_INTEGER) to the nearest double, which would corrupt the
 * value before any transform could see it.  We therefore detect unsafe
 * integer literals in the RAW source up front and skip the JSON branch
 * entirely on such inputs (treating them as plain text, which never reparses
 * numbers).  This narrows the lossless claim honestly: large integers are
 * left untouched rather than silently mangled.
 *
 * TOON readability tradeoff
 * ─────────────────────────
 * TOON (Token-Oriented Object Notation) renders tabular data far more
 * compactly than JSON, and Claude + other capable frontier models parse it
 * reliably in practice.  Weaker open-weight models may handle it less
 * consistently — that is why the TOON path is gated to CLEARLY TABULAR
 * data (uniform arrays of flat objects) and behind a user toggle.  For
 * any non-uniform or deeply nested structure we fall back to minified JSON,
 * which every model understands unambiguously.
 */

import { encode, decode } from '@toon-format/toon';

/** Output shape — never throws; format='unchanged' signals a no-op. */
export interface CompactResult {
  text: string;
  format: 'toon' | 'json-min' | 'text' | 'unchanged';
}

export interface CompactOptions {
  /**
   * Minimum array length before we attempt TOON encoding.
   * Below this threshold we still minify but skip the tabular path.
   * @default 8
   */
  minJsonArrayLen?: number;
  /**
   * Number of identical consecutive lines that triggers deduplication
   * in plain-text mode.
   * @default 4
   */
  minDupRun?: number;
}

/** Prefix prepended to TOON output so the model knows the encoding. */
const TOON_HEADER = '# TOON (compact table; same data as JSON)\n';

/**
 * Returns true when `arr` is a non-empty array of objects that all
 * have the same set of keys and no nested object/array values
 * (i.e. it is suitable for tabular TOON encoding).
 */
function isUniformFlatArray(arr: unknown[]): arr is Record<string, unknown>[] {
  if (arr.length === 0) return false;
  const first = arr[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return false;
  const keys = Object.keys(first as Record<string, unknown>).sort().join('\0');
  for (const item of arr) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const obj = item as Record<string, unknown>;
    if (Object.keys(obj).sort().join('\0') !== keys) return false;
    // Flat check: reject if any value is itself an object or array.
    for (const v of Object.values(obj)) {
      if (typeof v === 'object' && v !== null) return false;
    }
  }
  return true;
}

/**
 * Collapse runs of ≥ minDupRun identical consecutive lines, strip
 * trailing whitespace per line, and collapse 3+ consecutive blank
 * lines to one.  Returns the transformed string, or null when nothing
 * changed so the caller can keep format='unchanged'.
 */
function compactText(text: string, minDupRun: number): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;

  // Pass 1: trailing-whitespace strip + consecutive-duplicate collapse.
  let i = 0;
  while (i < lines.length) {
    const stripped = lines[i].trimEnd();
    if (stripped !== lines[i]) changed = true;

    // Count run of identical (post-strip) consecutive lines.
    let run = 1;
    while (i + run < lines.length && lines[i + run].trimEnd() === stripped) {
      run++;
    }

    if (run >= minDupRun) {
      out.push(stripped);
      out.push(`… [${run - 1} identical lines omitted] …`);
      changed = true;
      i += run;
    } else {
      // Push up to run lines (all are identical at this level, run < minDupRun).
      for (let k = 0; k < run; k++) {
        out.push(lines[i + k].trimEnd());
      }
      i += run;
    }
  }

  // Pass 2: collapse 3+ consecutive blank lines to one blank line.
  const out2: string[] = [];
  let blankRun = 0;
  for (const line of out) {
    if (line === '') {
      blankRun++;
      if (blankRun <= 1) out2.push(line);
      else changed = true;
    } else {
      blankRun = 0;
      out2.push(line);
    }
  }

  if (!changed) return null;
  return out2.join('\n');
}

/**
 * Structural deep-equality for JSON-shaped values (the output of JSON.parse
 * or TOON decode).  Used to PROVE a transform was lossless before accepting
 * it.  Handles primitives, arrays, and plain objects; key order is ignored.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // NaN === NaN is false above, but JSON has no NaN, so don't special-case it.
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * True when `text` contains a JSON integer literal whose magnitude exceeds
 * Number.MAX_SAFE_INTEGER (2^53−1), i.e. one that `JSON.parse` would round
 * to a different value.  We scan the raw source rather than the parsed tree
 * because the precision is already gone by the time `JSON.parse` returns.
 *
 * Matches integer-valued number tokens that are not part of a longer
 * identifier and are followed by a JSON structural boundary; a fractional or
 * exponent part means it was always a float and precision loss is expected,
 * so those are ignored.  Conservative: a false positive only means we skip
 * compaction (safe), never that we corrupt data.
 */
function hasUnsafeIntegerLiteral(text: string): boolean {
  // Integer tokens: optional sign, digits, NOT followed by '.', 'e', 'E', or
  // another digit/identifier char. Preceded by start, whitespace, or a JSON
  // structural char so we don't match inside strings' worth of digits like
  // version-ish tokens — but strings are JSON too, so also guard the lead.
  const re = /(^|[\s,:[\]{])(-?\d+)(?![\d.eE])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[2];
    // Quick length gate: MAX_SAFE_INTEGER is 16 digits (9007199254740991).
    const abs = digits.replace('-', '');
    if (abs.length < 16) continue;
    try {
      if (BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER) ||
          BigInt(digits) < BigInt(Number.MIN_SAFE_INTEGER)) {
        return true;
      }
    } catch {
      // Not a valid bigint (shouldn't happen for \d+) — be safe.
      return true;
    }
  }
  return false;
}

/**
 * Compact a tool-result string.  Pure function — never throws, never
 * mutates its input.  Returns the (possibly smaller) text and a format
 * tag describing what was done.
 *
 * Only returns a compacted form when it is ACTUALLY shorter than the
 * original; otherwise returns {text, format:'unchanged'}.
 */
export function compactToolResult(
  text: string,
  opts?: CompactOptions,
): CompactResult {
  const minJsonArrayLen = opts?.minJsonArrayLen ?? 8;
  const minDupRun = opts?.minDupRun ?? 4;

  try {
    // ── JSON branch ────────────────────────────────────────────────────
    // Precision guard (A): if the raw source holds an integer literal beyond
    // ±2^53−1, JSON.parse would already have rounded it.  Skip the JSON branch
    // entirely and treat the input as plain text — never reparse the number.
    let parsed: unknown;
    if (!hasUnsafeIntegerLiteral(text)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (parsed !== undefined) {
      // Uniform flat array → try TOON.
      // (B) Accept TOON only if decoding it back deep-equals the source.
      if (Array.isArray(parsed) && parsed.length >= minJsonArrayLen && isUniformFlatArray(parsed)) {
        try {
          const toon = TOON_HEADER + encode(parsed);
          if (toon.length < text.length) {
            const roundTrip = decode(encode(parsed));
            if (deepEqual(roundTrip, parsed)) {
              return { text: toon, format: 'toon' };
            }
            // Decode mismatch — TOON would lose data. Fall through to minify.
          }
        } catch {
          // TOON encode/decode failed — fall through to minify.
        }
      }

      // All other JSON → minify.
      // Accept only if the minified output re-parses to the same value.
      try {
        const minified = JSON.stringify(parsed);
        if (minified.length < text.length && deepEqual(JSON.parse(minified), parsed)) {
          return { text: minified, format: 'json-min' };
        }
      } catch {
        // JSON.stringify failure is essentially impossible but guard anyway.
      }

      // Neither path produced a shorter result.
      return { text, format: 'unchanged' };
    }

    // ── Plain-text branch ──────────────────────────────────────────────
    const compacted = compactText(text, minDupRun);
    if (compacted !== null && compacted.length < text.length) {
      return { text: compacted, format: 'text' };
    }
    return { text, format: 'unchanged' };
  } catch {
    // Catch-all: never corrupt the original content.
    return { text, format: 'unchanged' };
  }
}
