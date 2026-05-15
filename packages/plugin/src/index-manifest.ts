/**
 * Vault-index manifest + diff (phase 6 deep).
 *
 * The plugin tracks per-file `{mtime, size}` for every indexed
 * markdown note in plugin data. On reindex, a diff against the
 * current vault state surfaces three sets:
 *
 *   - added:    files that didn't exist last time
 *   - modified: files whose mtime or size changed
 *   - deleted:  files in the manifest that no longer exist on disk
 *
 * Only the delta is shipped to the Worker's /index endpoint,
 * cutting re-embedding cost to roughly the rate of vault churn —
 * for a steady-state 1000-note vault with ~10% monthly edits, that's
 * ~3-4 notes per reindex on average instead of 1000.
 *
 * `mtime + size` is the change signal rather than sha256. mtime is
 * cheap to read from TFile.stat without opening the file; size is
 * a strong tiebreaker against accidental touches. False positives
 * (re-embedding identical content after a touch+revert cycle) are
 * cheap; false negatives (missing a real change) would be a
 * staleness bug, so the signal needs to err toward over-reindexing.
 *
 * Pure module — no Obsidian dependencies — so the diff logic is
 * unit-testable with fixtures, satisfying vacuity-detection:
 * concrete current/previous → concrete added/modified/deleted.
 */

export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  /** Modification time in ms (epoch). */
  mtime: number;
  /** File size in bytes — secondary change signal. */
  size: number;
  /** When the worker last embedded this path (ms epoch). For
   * future "this entry is older than the embedding model upgrade"
   * triggers. */
  lastEmbedded: number;
}

export interface IndexManifest {
  version: typeof MANIFEST_VERSION;
  entries: Record<string, ManifestEntry>;
}

export interface FileInfo {
  path: string;
  mtime: number;
  size: number;
}

export interface ManifestDiff {
  added: FileInfo[];
  modified: FileInfo[];
  deleted: string[];
  /** Paths present in both current + manifest with no observed
   * change. Returned for diagnostics; not shipped to /index. */
  unchanged: string[];
}

export function emptyManifest(): IndexManifest {
  return { version: MANIFEST_VERSION, entries: {} };
}

/**
 * Compute the diff between the current vault state and the stored
 * manifest. Pure: same inputs → same outputs.
 */
export function diffAgainstManifest(
  current: FileInfo[],
  manifest: IndexManifest,
): ManifestDiff {
  const currentByPath = new Map(current.map((f) => [f.path, f]));
  const added: FileInfo[] = [];
  const modified: FileInfo[] = [];
  const unchanged: string[] = [];
  for (const f of current) {
    const prev = manifest.entries[f.path];
    if (!prev) {
      added.push(f);
    } else if (prev.mtime !== f.mtime || prev.size !== f.size) {
      modified.push(f);
    } else {
      unchanged.push(f.path);
    }
  }
  const deleted: string[] = [];
  for (const path of Object.keys(manifest.entries)) {
    if (!currentByPath.has(path)) deleted.push(path);
  }
  return { added, modified, deleted, unchanged };
}

/**
 * Apply a successful reindex to the manifest: every embedded file
 * is written/updated; every deleted file is removed. Returns the
 * new manifest (does not mutate the input).
 */
export function applyDiff(
  manifest: IndexManifest,
  diff: ManifestDiff,
  embeddedAt: number = Date.now(),
): IndexManifest {
  const entries: Record<string, ManifestEntry> = { ...manifest.entries };
  for (const f of diff.added) {
    entries[f.path] = {
      mtime: f.mtime,
      size: f.size,
      lastEmbedded: embeddedAt,
    };
  }
  for (const f of diff.modified) {
    entries[f.path] = {
      mtime: f.mtime,
      size: f.size,
      lastEmbedded: embeddedAt,
    };
  }
  for (const path of diff.deleted) {
    delete entries[path];
  }
  return { version: MANIFEST_VERSION, entries };
}
