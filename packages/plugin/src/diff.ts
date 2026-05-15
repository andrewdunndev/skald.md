/**
 * LCS-based unified line diff. Pure function; outputs an alternating
 * sequence of {type: 'same'|'add'|'remove', text} lines suitable for
 * rendering as the body of a diff card.
 *
 * Extracted from view.ts so the diff-card renderer + any future
 * unit tests can import without dragging in the Obsidian runtime.
 */

export interface DiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  // Standard longest-common-subsequence DP. O(m·n) — fine for the
  // sub-1000-line diffs the approval card handles; replace with a
  // Myers-style algorithm if we ever surface multi-kfile diffs.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.unshift({ type: 'same', text: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: 'add', text: b[j - 1] });
      j -= 1;
    } else {
      out.unshift({ type: 'remove', text: a[i - 1] });
      i -= 1;
    }
  }
  return out;
}
