/**
 * Tests for announceableText — the pure decision behind the polite
 * ARIA live region (fix: streaming output not announced to screen
 * readers). The DOM mechanics of LiveRegion (createDiv + setAttrs)
 * are not unit-tested here; the node test harness is intentionally
 * DOM-free (see tests/obsidian-mock.ts). This covers WHAT gets
 * announced, which is the load-bearing accessibility behavior:
 * only finalized, visible assistant text reaches the screen reader.
 */
import { describe, expect, it } from 'vitest';
import { announceableText } from './live-region';
import type { Message } from '@skald/protocol';

describe('announceableText', () => {
  it('returns trimmed string content verbatim', () => {
    const msg: Message = { role: 'assistant', content: '  hello world  ' };
    expect(announceableText(msg)).toBe('hello world');
  });

  it('concatenates multiple text blocks with a blank line', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    };
    expect(announceableText(msg)).toBe('first\n\nsecond');
  });

  it('skips thinking blocks — internal reasoning is never announced', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'secret chain of thought' },
        { type: 'text', text: 'the answer' },
      ],
    };
    expect(announceableText(msg)).toBe('the answer');
  });

  it('skips tool_use and image blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'read_note', input: {} },
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'text', text: 'done' },
      ],
    };
    expect(announceableText(msg)).toBe('done');
  });

  it('returns empty string for a tool-only turn (nothing to speak)', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'write_note', input: {} }],
    };
    expect(announceableText(msg)).toBe('');
  });

  it('returns empty string for empty / whitespace-only text', () => {
    expect(announceableText({ role: 'assistant', content: '   ' })).toBe('');
    expect(
      announceableText({
        role: 'assistant',
        content: [{ type: 'text', text: '   ' }],
      }),
    ).toBe('');
  });
});
