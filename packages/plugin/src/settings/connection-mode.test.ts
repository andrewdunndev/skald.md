/**
 * migrateConnectionMode tests. This function determines the default
 * connection mode for each install scenario, so regressions here would
 * silently break Worker users on upgrade or leave fresh installs defaulting
 * to the wrong mode.
 */
import { describe, expect, it } from 'vitest';
import { migrateConnectionMode } from './connection-mode';

describe('migrateConnectionMode: fresh install', () => {
  it('returns direct when stored data is empty', () => {
    expect(migrateConnectionMode({})).toBe('direct');
  });

  it('returns direct when workerUrl is absent from stored data', () => {
    expect(migrateConnectionMode({ defaultModel: 'claude-sonnet-4-6' })).toBe('direct');
  });

  it('returns direct when workerUrl is an empty string', () => {
    expect(migrateConnectionMode({ workerUrl: '' })).toBe('direct');
  });

  it('returns direct when workerUrl is whitespace-only', () => {
    expect(migrateConnectionMode({ workerUrl: '   ' })).toBe('direct');
  });
});

describe('migrateConnectionMode: upgrade from worker era', () => {
  it('returns worker when a Worker URL is already configured', () => {
    expect(
      migrateConnectionMode({ workerUrl: 'wss://skald.user.workers.dev' }),
    ).toBe('worker');
  });

  it('returns worker even when workerToken is absent (URL is enough signal)', () => {
    expect(
      migrateConnectionMode({
        workerUrl: 'wss://skald.user.workers.dev',
        // no workerToken — the key might have been set separately
      }),
    ).toBe('worker');
  });
});

describe('migrateConnectionMode: explicit value in stored data', () => {
  it('respects a stored direct value', () => {
    expect(
      migrateConnectionMode({
        connectionMode: 'direct',
        workerUrl: 'wss://skald.user.workers.dev',
      }),
    ).toBe('direct');
  });

  it('respects a stored worker value', () => {
    expect(
      migrateConnectionMode({ connectionMode: 'worker', workerUrl: '' }),
    ).toBe('worker');
  });

  it('treats an unknown stored value as absent (falls back to url heuristic)', () => {
    expect(
      migrateConnectionMode({
        connectionMode: 'legacy' as string,
        workerUrl: 'wss://skald.user.workers.dev',
      }),
    ).toBe('worker');
  });

  it('falls back to direct when stored value is unknown and no workerUrl', () => {
    expect(
      migrateConnectionMode({ connectionMode: 'unknown-future-value' as string }),
    ).toBe('direct');
  });
});
