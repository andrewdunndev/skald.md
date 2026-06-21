/**
 * Tests for memory-upkeep.ts — provider-neutral vault-memory upkeep pass.
 *
 * Covers:
 *   1. proposeMemoryUpkeep: happy path — returns proposed body with a new fact
 *   2. proposeMemoryUpkeep: soft-fails (returns null) on API error
 *   3. proposeMemoryUpkeep: returns null when memoryEnabled=false (no API key)
 *   4. proposeMemoryUpkeep: uses resolveUtilityModel, not a hardcoded model
 *   5. proposeMemoryUpkeep: returns null when proposed matches current body
 *   6. proposeMemoryUpkeep: OpenRouter path hits OpenRouter URL
 *   7. isUpkeepDue: cadence gate
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import {
  proposeMemoryUpkeep,
  isUpkeepDue,
  UPKEEP_EVERY_N_TURNS,
  UPKEEP_MAX_DELETION_FRACTION,
} from './memory-upkeep';
import type { Message } from '@skald/protocol';

// ── helpers ───────────────────────────────────────────────────────────────────

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function makeMessages(extra: string): Message[] {
  return [
    { role: 'user', content: `My favourite colour is ${extra}.` },
    { role: 'assistant', content: 'Got it, I will remember that.' },
  ];
}

function mockAnthropicOk(body: string) {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 200,
    json: { content: [{ type: 'text', text: body }] },
    text: body,
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

function mockOpenRouterOk(body: string) {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 200,
    json: { choices: [{ message: { content: body } }] },
    text: body,
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

function mockError() {
  vi.mocked(obsidian.requestUrl).mockRejectedValue(new Error('network error'));
}

function mockNon200() {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 429,
    json: {},
    text: 'rate limited',
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

// ── isUpkeepDue ───────────────────────────────────────────────────────────────

describe('isUpkeepDue', () => {
  it('returns false before UPKEEP_EVERY_N_TURNS', () => {
    expect(isUpkeepDue(UPKEEP_EVERY_N_TURNS - 1)).toBe(false);
  });

  it('returns true at exactly UPKEEP_EVERY_N_TURNS', () => {
    expect(isUpkeepDue(UPKEEP_EVERY_N_TURNS)).toBe(true);
  });

  it('returns true beyond UPKEEP_EVERY_N_TURNS', () => {
    expect(isUpkeepDue(UPKEEP_EVERY_N_TURNS + 3)).toBe(true);
  });
});

// ── proposeMemoryUpkeep ───────────────────────────────────────────────────────

describe('proposeMemoryUpkeep: Anthropic path', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the proposed body on a successful Anthropic call', async () => {
    const proposed = 'Favourite colour: blue';
    mockAnthropicOk(proposed);

    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('blue'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBe(proposed);
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    expect((call as { url: string }).url).toBe(ANTHROPIC_MESSAGES_URL);
  });

  it('uses the model supplied by the caller (resolveUtilityModel)', async () => {
    mockAnthropicOk('some body');
    await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('red'),
      model: 'my-custom-utility-model',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    expect(body.model).toBe('my-custom-utility-model');
  });

  it('soft-fails to null on network error', async () => {
    mockError();
    const result = await proposeMemoryUpkeep({
      memoryBody: 'existing',
      messages: makeMessages('green'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBeNull();
  });

  it('soft-fails to null on non-200 response', async () => {
    mockNon200();
    const result = await proposeMemoryUpkeep({
      memoryBody: 'existing',
      messages: makeMessages('yellow'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBeNull();
  });

  it('returns null when proposed body matches current body (no change)', async () => {
    const same = 'unchanged memory note';
    mockAnthropicOk(same);
    const result = await proposeMemoryUpkeep({
      memoryBody: same,
      messages: makeMessages('orange'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBeNull();
  });
});

describe('proposeMemoryUpkeep: no API key', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns null without calling the API when apiKey is empty', async () => {
    const spy = vi.mocked(obsidian.requestUrl);
    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('purple'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: '',
    });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('proposeMemoryUpkeep: OpenRouter path', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('calls the OpenRouter endpoint when provider=openrouter', async () => {
    mockOpenRouterOk('Favourite colour: cyan');
    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('cyan'),
      model: 'anthropic/claude-haiku-4-5',
      provider: 'openrouter',
      apiKey: 'or-test-key',
    });

    expect(result).toBe('Favourite colour: cyan');
    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    expect((call as { url: string }).url).toBe(OPENROUTER_URL);
  });

  it('uses the correct model in the OpenRouter request', async () => {
    mockOpenRouterOk('updated');
    await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('teal'),
      model: 'meta-llama/llama-3-8b',
      provider: 'openrouter',
      apiKey: 'or-test-key',
    });

    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    expect(body.model).toBe('meta-llama/llama-3-8b');
  });

  it('soft-fails to null on OpenRouter error', async () => {
    mockError();
    const result = await proposeMemoryUpkeep({
      memoryBody: 'existing',
      messages: makeMessages('magenta'),
      model: 'anthropic/claude-haiku-4-5',
      provider: 'openrouter',
      apiKey: 'or-test-key',
    });
    expect(result).toBeNull();
  });
});

// ── Fix 1: data-loss via truncation + whole-note overwrite ─────────────────────

describe('proposeMemoryUpkeep: max_tokens never truncates a long note', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends a max_tokens far above the old 512 cap so long notes are not truncated', async () => {
    // A realistic memory note longer than the old 512-token cap (~2000+ words).
    // The whole proposed body is later written as an overwrite, so the request
    // must allow enough output to never truncate it.
    // Passes on correct code; FAILS under mutation "set max_tokens back to 512".
    const longNote = Array.from({ length: 400 }, (_, i) => `Fact ${i}: durable detail about the user.`).join('\n');
    mockAnthropicOk(longNote + '\nFact 400: a newly learned fact.');

    const result = await proposeMemoryUpkeep({
      memoryBody: longNote,
      messages: makeMessages('blue'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    // The proposal is returned in full (a new fact was added, deletion guard not tripped).
    expect(result).toContain('Fact 400: a newly learned fact.');

    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const body = JSON.parse((call as { body: string }).body);
    // The cap must be high enough that the full note fits. 512 would truncate.
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
  });
});

describe('proposeMemoryUpkeep: deletion guard', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('rejects a proposal that drops more than the threshold of the note (no overwrite proposed)', async () => {
    // Existing note has 5 facts; the model returns just 1 — a ~80% wipe.
    // Passes on correct code; FAILS under mutation "remove the deletion guard".
    const existing = [
      'Name: Jane Doe',
      'Lives in: Grand Rapids',
      'Has two kids: Alice and Bob',
      'Prefers tea over coffee',
      'Allergic to peanuts',
    ].join('\n');
    const suspectShrink = 'Name: Jane Doe'; // drops 4 of 5 facts
    mockAnthropicOk(suspectShrink);

    const result = await proposeMemoryUpkeep({
      memoryBody: existing,
      messages: makeMessages('green'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBeNull();
  });

  it('allows a proposal that prunes less than the threshold', async () => {
    // Removing one short stale line from a large note stays well under the cap.
    const existing = Array.from({ length: 20 }, (_, i) => `Fact ${i}: a durable detail.`).join('\n');
    const lightPrune = Array.from({ length: 19 }, (_, i) => `Fact ${i}: a durable detail.`).join('\n');
    mockAnthropicOk(lightPrune);

    const result = await proposeMemoryUpkeep({
      memoryBody: existing,
      messages: makeMessages('red'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBe(lightPrune);
  });

  it('always allows first-population (empty existing note → content)', async () => {
    mockAnthropicOk('Favourite colour: blue');
    const result = await proposeMemoryUpkeep({
      memoryBody: '',
      messages: makeMessages('blue'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });
    expect(result).toBe('Favourite colour: blue');
  });

  it('threshold constant is the conservative 40%', () => {
    expect(UPKEEP_MAX_DELETION_FRACTION).toBe(0.4);
  });
});

// ── Fix 2: cosmetic-diff spurious cards ────────────────────────────────────────

describe('proposeMemoryUpkeep: cosmetic-only changes are not proposed', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null when the proposal differs ONLY by whitespace/blank-lines/line-trim', async () => {
    // Same facts, reformatted: extra blank lines, trailing spaces, indentation.
    // Passes on correct code; FAILS under mutation "compare with plain trim()
    // instead of normalizeNoteBody" — these would register as a change.
    const original = 'Name: Jane\nLikes: tea\nCity: Grand Rapids';
    const cosmetic = '\n  Name: Jane  \n\n\tLikes: tea\n\nCity: Grand Rapids   \n';
    mockAnthropicOk(cosmetic);

    const result = await proposeMemoryUpkeep({
      memoryBody: original,
      messages: makeMessages('orange'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBeNull();
  });

  it('DOES propose when a real new fact is added (not cosmetic)', async () => {
    const original = 'Name: Jane\nLikes: tea';
    const withNewFact = 'Name: Jane\nLikes: tea\nCity: Grand Rapids';
    mockAnthropicOk(withNewFact);

    const result = await proposeMemoryUpkeep({
      memoryBody: original,
      messages: makeMessages('teal'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBe(withNewFact);
  });
});

// utilityModel() resolution (provider defaults + override) is covered in
// provider-capabilities.test.ts. The memory-upkeep guard that matters —
// that the caller-supplied model flows into the request body rather than a
// hardcoded one — is asserted above ("uses the model supplied by the
// caller (resolveUtilityModel)").
//
// Fix 2: frontmatter preservation tests are in memory-upkeep.frontmatter.test.ts
// (split out to keep this file under the 400-line cap).
