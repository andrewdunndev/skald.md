/**
 * Anthropic provider dispatch tests. Every assertion names the exact
 * URL / header values so a regression in the upstream wire format
 * fails loudly — these headers are what api.anthropic.com sees,
 * silent changes (e.g. version pin slip) corrupt every chat turn.
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '@scribian/protocol';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_VERSION,
  anthropicHeaders,
  anthropicUrl,
  transformAnthropicEvent,
  transformAnthropicRequest,
} from './anthropic';

const BASE_REQUEST: ChatRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1024,
};

describe('anthropicUrl', () => {
  it('returns api.anthropic.com/v1/messages when AI_GATEWAY_URL is unset', () => {
    expect(anthropicUrl({})).toBe(
      `${ANTHROPIC_BASE_URL}${ANTHROPIC_MESSAGES_PATH}`,
    );
    expect(anthropicUrl({})).toBe('https://api.anthropic.com/v1/messages');
  });

  it('returns AI_GATEWAY_URL when set (full URL replacement)', () => {
    const aigw = 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages';
    expect(anthropicUrl({ AI_GATEWAY_URL: aigw })).toBe(aigw);
  });
});

describe('anthropicHeaders', () => {
  it('sets the exact required headers for a direct call', () => {
    const headers = anthropicHeaders('sk-ant-xxx', {}, 'claude-sonnet-4-6', false);
    expect(headers['x-api-key']).toBe('sk-ant-xxx');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toContain('scribian/');
  });

  it('omits cf-aig-metadata when AI_GATEWAY_URL is unset', () => {
    const headers = anthropicHeaders('k', {}, 'claude-sonnet-4-6', false);
    expect(headers['cf-aig-metadata']).toBeUndefined();
  });

  it('adds cf-aig-metadata with app/model/has_tools when AI Gateway is configured', () => {
    const headers = anthropicHeaders(
      'k',
      { AI_GATEWAY_URL: 'https://gw.example' },
      'claude-opus-4-7',
      true,
    );
    expect(headers['cf-aig-metadata']).toBeDefined();
    const meta = JSON.parse(headers['cf-aig-metadata']);
    expect(meta).toEqual({
      app: 'scribian',
      model: 'claude-opus-4-7',
      has_tools: true,
    });
  });

  it('marks has_tools=false in cf-aig-metadata when no tools', () => {
    const headers = anthropicHeaders(
      'k',
      { AI_GATEWAY_URL: 'https://gw.example' },
      'claude-haiku-4-5',
      false,
    );
    const meta = JSON.parse(headers['cf-aig-metadata']);
    expect(meta.has_tools).toBe(false);
  });
});

describe('transformAnthropicRequest', () => {
  it('preserves tools arrays verbatim (no rewriting)', () => {
    const req: ChatRequest = {
      ...BASE_REQUEST,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { name: 'read_note', input_schema: {} },
      ],
    };
    const out = transformAnthropicRequest(req);
    expect(out.tools).toBe(req.tools);
    expect(out.tools![0]).toEqual({
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 5,
    });
  });
});

describe('transformAnthropicEvent', () => {
  it('returns event + data unchanged', () => {
    const data = { foo: 'bar' };
    expect(transformAnthropicEvent('message_start', data)).toEqual({
      event: 'message_start',
      data,
    });
    expect(transformAnthropicEvent('content_block_start', data).data).toBe(data);
  });
});
