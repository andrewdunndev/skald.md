/**
 * Tests for the saved-conversation markdown rendering. The render
 * is also the de facto wire format users see in their vault — so
 * we lock down the shape with concrete I/O assertions, plus a
 * snapshot of the full render for a representative conversation.
 *
 * No inverse-parser exists yet (conversations are render-only
 * from the plugin side); when one ships, this file gets a
 * proper round-trip test. For now we test render correctness +
 * frontmatter shape.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@scribian/protocol';
import {
  renderConversationMarkdown,
  type ConversationMeta,
} from './conversation-store';

const META: ConversationMeta = {
  id: '00000000-0000-0000-0000-000000000abc',
  model: 'claude-sonnet-4-6',
  created: '2026-05-15T08:30:00.000Z',
  updated: '2026-05-15T08:35:00.000Z',
};

describe('renderConversationMarkdown', () => {
  it('renders the required frontmatter fields', () => {
    const out = renderConversationMarkdown(META, [
      { role: 'user', content: 'hello' },
    ]);
    expect(out).toContain('scribian-conversation-id: 00000000-0000-0000-0000-000000000abc');
    expect(out).toContain('scribian-model: claude-sonnet-4-6');
    expect(out).toContain('created: 2026-05-15T08:30:00.000Z');
    expect(out).toContain('updated: 2026-05-15T08:35:00.000Z');
  });

  it('omits usage frontmatter when not provided (back-compat)', () => {
    const out = renderConversationMarkdown(META, [
      { role: 'user', content: 'hello' },
    ]);
    expect(out).not.toContain('input_tokens:');
    expect(out).not.toContain('estimated_cost_usd:');
  });

  it('writes the four usage frontmatter fields when present', () => {
    const out = renderConversationMarkdown(
      {
        ...META,
        usage: {
          input_tokens: 1234,
          output_tokens: 5678,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        costUSD: 0.0921,
      },
      [{ role: 'user', content: 'hi' }],
    );
    expect(out).toContain('input_tokens: 1234');
    expect(out).toContain('output_tokens: 5678');
    expect(out).toContain('cache_read_input_tokens: 100');
    expect(out).toContain('cache_creation_input_tokens: 50');
    expect(out).toContain('estimated_cost_usd: 0.092100');
  });

  it('omits cache fields when they are zero', () => {
    const out = renderConversationMarkdown(
      {
        ...META,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
        },
        costUSD: 0.01,
      },
      [{ role: 'user', content: 'x' }],
    );
    expect(out).toContain('input_tokens: 100');
    expect(out).not.toContain('cache_read_input_tokens');
    expect(out).not.toContain('cache_creation_input_tokens');
  });

  it('omits cost when it is zero', () => {
    const out = renderConversationMarkdown(
      {
        ...META,
        usage: { input_tokens: 0, output_tokens: 0 },
        costUSD: 0,
      },
      [{ role: 'user', content: 'x' }],
    );
    expect(out).not.toContain('estimated_cost_usd');
  });

  it('renders a basic user → assistant exchange', () => {
    const messages: Message[] = [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: [{ type: 'text', text: '4.' } as any] },
    ];
    const out = renderConversationMarkdown(META, messages);
    expect(out).toContain('## You');
    expect(out).toContain('What is 2+2?');
    expect(out).toContain('## Claude');
    expect(out).toContain('4.');
  });

  it('strips <context> wrapper from user messages but lists attached paths', () => {
    const user: Message = {
      role: 'user',
      content:
        '<context>\n  <file path="Notes/A.md">body of A</file>\n</context>\n\nWhat do you think?',
    };
    const out = renderConversationMarkdown(META, [user]);
    expect(out).not.toContain('body of A'); // body stripped
    expect(out).toContain('[[Notes/A.md]]'); // attached path surfaced
    expect(out).toContain('What do you think?');
  });

  it('compresses tool_use to a one-liner', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'read_note',
          input: { path: 'A.md' },
        } as any,
      ],
    };
    const out = renderConversationMarkdown(META, [msg]);
    expect(out).toContain('🔧');
    expect(out).toContain('Reading A.md');
  });

  it('marks tool_result errors with a warning icon', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'Note not found: foo.md',
          is_error: true,
        } as any,
      ],
    };
    const out = renderConversationMarkdown(META, [msg]);
    expect(out).toContain('⚠️ tool error');
    expect(out).toContain('Note not found');
  });

  it('renders web_search_tool_result as a count line', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 's1',
          content: [{}, {}, {}],
        } as any,
      ],
    };
    const out = renderConversationMarkdown(META, [msg]);
    expect(out).toContain('web search returned 3 results');
  });

  it('emits an image placeholder, not the base64 payload', () => {
    const msg: Message = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: 'BIG_BASE64_PAYLOAD_HERE',
          },
        } as any,
      ],
    };
    const out = renderConversationMarkdown(META, [msg]);
    expect(out).not.toContain('BIG_BASE64_PAYLOAD_HERE');
    expect(out).toContain('image/jpeg');
    expect(out).toContain('omitted from saved record');
  });

  it('full render snapshot (representative conversation)', () => {
    const out = renderConversationMarkdown(
      {
        ...META,
        usage: {
          input_tokens: 482,
          output_tokens: 1503,
          cache_read_input_tokens: 9300,
        },
        costUSD: 0.0247,
      },
      [
        {
          role: 'user',
          content:
            '<context>\n  <file path="Bailey.md">She is a dog.</file>\n</context>\n\nIs Bailey allergic to anything?',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Let me check the note.',
            } as any,
            {
              type: 'tool_use',
              id: 't1',
              name: 'read_note',
              input: { path: 'Bailey.md' },
            } as any,
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'She is a dog.',
            } as any,
            {
              type: 'text',
              text: "Yes — the note doesn't say. Want me to ask the vet?",
            } as any,
          ],
        },
      ],
    );
    expect(out).toMatchSnapshot();
  });
});
