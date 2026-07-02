/**
 * Vitest config — workspace root. Each test file lives next to its
 * source as `<name>.test.ts`. Tests target pure modules (no Obsidian
 * runtime, no Worker bindings) so they execute in plain Node.
 *
 * For tests that import 'obsidian', the alias below routes to a
 * thin mock module at tests/obsidian-mock.ts; only the surface the
 * pure modules actually touch is mocked (TFile, TFolder,
 * normalizePath, prepareFuzzySearch). Adding more requires extending
 * the mock — and that's the right time to ask whether the module
 * under test is actually pure.
 *
 * Architectural rationale (per dunn.dev/reference principles):
 *   - vacuity detection: tests must assert specific behavior on
 *     specific inputs. The presence of an assertion is not the
 *     check; the assertion's value is.
 *   - bundled enforcement: the typecheck + test commands run from
 *     CI; nothing ships without both passing.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, 'tests/obsidian-mock.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    // vitest 4's restoreAllMocks no longer clears call state between tests
    // (v3 did); clearMocks restores that invariant suite-wide.
    clearMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        // The Obsidian-DOM UI layer is covered by the CDP walkthrough +
        // on-device testing, NOT vitest (env is 'node'). Excluding it from the
        // unit-coverage floor keeps the gate honest: the floor measures the
        // pure, unit-testable core, not UI that unit tests structurally can't reach.
        'packages/plugin/src/view/**',
        'packages/plugin/src/view.ts',
        'packages/plugin/src/main.ts',
        'packages/plugin/src/settings.ts',
        'packages/plugin/src/settings/**',
        'packages/plugin/src/conversation-search.ts',
      ],
      reporter: ['text', 'text-summary', 'json-summary'],
      // Ratchet floor on the unit-testable core (baseline ~84% lines / 81%
      // branch). Set AT the baseline so coverage can never silently regress;
      // raise toward 90% as gap-filling lands. Mutation testing (Stryker, on the
      // parsers) is the quality backstop so this stays real, not padding.
      thresholds: { lines: 84, statements: 84, functions: 85, branches: 80 },
    },
  },
});
