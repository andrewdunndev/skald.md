import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@skald/protocol';
import { DirectTransport } from '../../plugin/src/direct-transport';
import {
  MOCK_AFTER_TOOL, MOCK_REPLY, TOOL_CONTENT, TOOL_PATH, TOOL_TRIGGER,
  startMockProvider, type MockProvider,
} from './mock-provider';

describe('e2e mock provider speaks the wire format DirectTransport parses', () => {
  let mock: MockProvider;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    mock = await startMockProvider();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      realFetch(url.replace('https://api.anthropic.com', mock.origin), init));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await mock.close();
  });

  async function turn(content: unknown): Promise<ServerMessage[]> {
    const messages: ServerMessage[] = [];
    const transport = new DirectTransport(
      { getAnthropicKey: () => 'sk-ant-test', getOpenRouterKey: () => '' },
      { onOpen: vi.fn(), onClose: vi.fn(), onError: vi.fn(), onMessage: (m) => messages.push(m) },
    );
    transport.connect();
    transport.send({
      type: 'chat',
      id: 't1',
      payload: { model: 'claude-haiku-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content }] },
    } as never);
    await vi.waitUntil(() => messages.some((m) => m.type === 'done' || m.type === 'error'), { timeout: 5000 });
    return messages;
  }

  const textOf = (msgs: ServerMessage[]) =>
    msgs
      .filter((m) => m.type === 'chunk' && (m as any).event === 'content_block_delta')
      .map((m) => (m as any).data?.delta?.text ?? '')
      .join('');

  it('plain turn streams the scripted text and ends with end_turn', async () => {
    const msgs = await turn('hello');
    expect(textOf(msgs)).toBe(MOCK_REPLY);
    expect(msgs.find((m) => m.type === 'done')).toMatchObject({ stop_reason: 'end_turn' });
    expect(mock.requests[0].apiKey).toBe('sk-ant-test');
  });

  it('trigger phrase streams an append_to_note tool_use that reassembles to valid JSON', async () => {
    const msgs = await turn(`go ${TOOL_TRIGGER}`);
    const start = msgs.find((m) => m.type === 'chunk' && (m as any).data?.content_block?.type === 'tool_use') as any;
    expect(start.data.content_block).toMatchObject({ id: 'toolu_mock_1', name: 'append_to_note' });
    const json = msgs
      .filter((m) => m.type === 'chunk' && (m as any).data?.delta?.type === 'input_json_delta')
      .map((m) => (m as any).data.delta.partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ path: TOOL_PATH, content: TOOL_CONTENT });
    expect(msgs.find((m) => m.type === 'done')).toMatchObject({ stop_reason: 'tool_use' });
  });

  it('a tool_result turn gets the closing text', async () => {
    const msgs = await turn([{ type: 'tool_result', tool_use_id: 'toolu_mock_1', content: 'ok' }]);
    expect(textOf(msgs)).toBe(MOCK_AFTER_TOOL);
  });

  it('answers the CORS preflight a renderer fetch sends', async () => {
    const res = await realFetch(`${mock.origin}/v1/messages`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
