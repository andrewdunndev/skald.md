import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@skald/protocol';
import { DirectTransport } from './direct-transport';

/**
 * Defense-in-depth: the transport must refuse to dispatch the API key
 * and prompt to a cleartext, non-loopback OpenAI-compatible base URL —
 * even if data.json was hand-edited to bypass the settings-UI check.
 */
describe('DirectTransport: OpenAI base-url enforcement', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function run(baseUrl: string, onMessage: (m: ServerMessage) => void) {
    const transport = new DirectTransport(
      {
        getAnthropicKey: () => '',
        getOpenRouterKey: () => '',
        getOpenAiKey: () => 'sk-secret',
      },
      { onOpen: vi.fn(), onClose: vi.fn(), onMessage, onError: vi.fn() },
    );
    transport.connect();
    transport.send({
      type: 'chat',
      id: 't1',
      provider: 'openai',
      openai_base_url: baseUrl,
      payload: {
        model: 'qwen',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
  }

  it('rejects http on a remote host without ever calling fetch', async () => {
    const messages: ServerMessage[] = [];
    run('http://evil.example.com/v1', (m) => messages.push(m));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    const err = messages.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect((err as { error: string }).error).toMatch(/Insecure OpenAI-compatible base URL/);
  });

  it('allows http on loopback (dispatches fetch)', async () => {
    const messages: ServerMessage[] = [];
    run('http://localhost:11434/v1', (m) => messages.push(m));
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0, { timeout: 1000 });

    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('allows https on a remote host (dispatches fetch)', async () => {
    run('https://your-endpoint.example/v1', vi.fn());
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0, { timeout: 1000 });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://your-endpoint.example/v1/chat/completions',
    );
  });
});
