/**
 * Fix 2: memory-upkeep frontmatter preservation tests.
 *
 * Verifies that:
 *   - splitFrontmatter correctly splits / passes-through notes
 *   - proposeMemoryUpkeep sends only the body to the model
 *   - proposeMemoryUpkeep re-attaches the ORIGINAL frontmatter verbatim
 *   - the no-op suppression still works when frontmatter is present
 *
 * Split from memory-upkeep.test.ts to keep each file under the 400-line cap.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import * as obsidian from 'obsidian';
import { proposeMemoryUpkeep, splitFrontmatter } from './memory-upkeep';
import type { Message } from './protocol';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMessages(extra: string): Message[] {
  return [
    { role: 'user', content: `My city is ${extra}.` },
    { role: 'assistant', content: 'Got it.' },
  ];
}

function mockAnthropicOk(body: string) {
  vi.mocked(obsidian.requestUrl).mockResolvedValue({
    status: 200,
    json: { content: [{ type: 'text', text: body }] },
    text: body,
  } as ReturnType<typeof obsidian.requestUrl> extends Promise<infer R> ? R : never);
}

// ── splitFrontmatter unit tests ───────────────────────────────────────────────

describe('splitFrontmatter', () => {
  it('returns empty frontmatter and the full note when there is no frontmatter', () => {
    const note = 'Name: Jane\nLikes: tea';
    const { frontmatter, body } = splitFrontmatter(note);
    expect(frontmatter).toBe('');
    expect(body).toBe(note);
  });

  it('splits a standard YAML frontmatter block', () => {
    const note = '---\ntags: [memory]\ncreated: 2026-01-01\n---\nName: Jane\nLikes: tea';
    const { frontmatter, body } = splitFrontmatter(note);
    expect(frontmatter).toBe('---\ntags: [memory]\ncreated: 2026-01-01\n---\n');
    expect(body).toBe('Name: Jane\nLikes: tea');
  });

  it('re-joining frontmatter + body reproduces the original note verbatim', () => {
    const note = '---\ntags: [memory]\n---\nSome body content.\nAnother line.';
    const { frontmatter, body } = splitFrontmatter(note);
    expect(frontmatter + body).toBe(note);
  });

  it('handles a note that is only frontmatter (no body after fence)', () => {
    const note = '---\ntags: []\n---\n';
    const { frontmatter, body } = splitFrontmatter(note);
    expect(frontmatter).toBe('---\ntags: []\n---\n');
    expect(body).toBe('');
  });

  it('treats a lone opening --- with no closing fence as no frontmatter', () => {
    const note = '---\njust some text, no closing fence';
    const { frontmatter, body } = splitFrontmatter(note);
    expect(frontmatter).toBe('');
    expect(body).toBe(note);
  });

  it('handles an empty string note', () => {
    const { frontmatter, body } = splitFrontmatter('');
    expect(frontmatter).toBe('');
    expect(body).toBe('');
  });
});

// ── proposeMemoryUpkeep frontmatter integration ───────────────────────────────

describe('proposeMemoryUpkeep: frontmatter preservation', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('re-attaches the original frontmatter verbatim when the model returns an updated body', async () => {
    // The memory note has YAML frontmatter (Obsidian properties). The model
    // must only receive the body; the proposal must have the ORIGINAL
    // frontmatter re-attached — not whatever the model might invent.
    // Passes on correct code; FAILS under mutation "send the whole note to the
    // model and use its output directly" without re-attaching frontmatter.
    const frontmatter = '---\ntags: [memory]\ncreated: 2026-01-01\n---\n';
    const originalBody = 'Name: Jane\nLikes: tea';
    const note = frontmatter + originalBody;
    const updatedBody = 'Name: Jane\nLikes: tea\nCity: Grand Rapids';

    mockAnthropicOk(updatedBody);

    const result = await proposeMemoryUpkeep({
      memoryBody: note,
      messages: makeMessages('grand rapids'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).not.toBeNull();
    // Must begin with the EXACT original frontmatter block.
    expect(result!.startsWith(frontmatter)).toBe(true);
    // Body update must be present.
    expect(result).toContain('City: Grand Rapids');
  });

  it('sends only the body (not the frontmatter) to the model', async () => {
    // The model prompt must NOT include YAML frontmatter so the model
    // cannot accidentally alter or drop Obsidian properties.
    const frontmatter = '---\ntags: [memory]\n---\n';
    const originalBody = 'Name: Jane\nLikes: tea';
    const note = frontmatter + originalBody;

    mockAnthropicOk(originalBody + '\nCity: Grand Rapids');

    await proposeMemoryUpkeep({
      memoryBody: note,
      messages: makeMessages('grand rapids'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    const call = vi.mocked(obsidian.requestUrl).mock.calls[0][0];
    const reqBody = JSON.parse((call as { body: string }).body);
    const userPrompt: string = reqBody.messages[0].content;
    // Body fact present; frontmatter fence must NOT be in the prompt.
    expect(userPrompt).toContain('Name: Jane');
    expect(userPrompt).not.toContain('tags: [memory]');
  });

  it('returns null (no-op) when the model returns the same body and frontmatter is present', async () => {
    // Body-only no-op detection must work even when the note has frontmatter.
    const frontmatter = '---\ntags: [memory]\n---\n';
    const body = 'Name: Jane\nLikes: tea';
    const note = frontmatter + body;

    mockAnthropicOk(body); // model echoes the unchanged body

    const result = await proposeMemoryUpkeep({
      memoryBody: note,
      messages: makeMessages('nothing new'),
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    });

    expect(result).toBeNull();
  });
});
