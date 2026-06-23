/**
 * uniqueSavePath collision-retry tests.
 *
 * "Save as note" names files with a second-precision timestamp. Two saves
 * in the same second produced the same path — the second clobbered the
 * first (or threw on a strict vault), silently losing a saved note. The
 * fix probes for a free path and appends -2, -3, … on collision.
 */
import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { TFile } from '../../../../tests/obsidian-mock';
import { uniqueSavePath } from './message-actions';

/** App stub whose vault reports the given set of paths as already taken. */
function makeApp(taken: Set<string>): App {
  return {
    vault: {
      getAbstractFileByPath: (p: string) =>
        taken.has(p) ? new TFile(p) : null,
    },
  } as unknown as App;
}

const FOLDER = 'Skald/Saved';
const TS = '2026-05-15T08-30-00';

describe('uniqueSavePath', () => {
  it('returns the plain timestamped path when nothing collides', () => {
    const app = makeApp(new Set());
    expect(uniqueSavePath(app, FOLDER, TS)).toBe(`${FOLDER}/${TS}.md`);
  });

  it('appends -2 when the timestamped path is already taken', () => {
    // The first save of the second already exists. Without the retry the
    // second save would reuse this exact path and clobber the first.
    const app = makeApp(new Set([`${FOLDER}/${TS}.md`]));
    expect(uniqueSavePath(app, FOLDER, TS)).toBe(`${FOLDER}/${TS}-2.md`);
  });

  it('skips to the first free suffix when several collide', () => {
    const app = makeApp(
      new Set([
        `${FOLDER}/${TS}.md`,
        `${FOLDER}/${TS}-2.md`,
        `${FOLDER}/${TS}-3.md`,
      ]),
    );
    expect(uniqueSavePath(app, FOLDER, TS)).toBe(`${FOLDER}/${TS}-4.md`);
  });
});
