import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_REPLY = 'MOCK-REPLY: streaming works.';
export const MOCK_AFTER_TOOL = 'MOCK-DONE: tool result received.';
export const TOOL_TRIGGER = 'APPEND-TRIGGER';
export const TOOL_PATH = 'Garden/Flower Index.md';
export const TOOL_CONTENT = '- Marigold (orange, e2e)';

export interface RecordedRequest {
  path: string;
  apiKey: string | undefined;
  body: any;
}

export interface MockProvider {
  /** Origin to substitute for https://api.anthropic.com, e.g. http://127.0.0.1:41234 */
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function frame(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function textTurn(text: string): string[] {
  const mid = Math.ceil(text.length / 2);
  return [
    frame('message_start', { message: { id: 'msg_mock', role: 'assistant', content: [], usage: { input_tokens: 12, output_tokens: 0 } } }),
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } }),
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(mid) } }),
    frame('content_block_stop', { index: 0 }),
    frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
    frame('message_stop', {}),
  ];
}

function toolTurn(): string[] {
  const input = JSON.stringify({ path: TOOL_PATH, content: TOOL_CONTENT });
  const cut = Math.ceil(input.length / 2);
  return [
    frame('message_start', { message: { id: 'msg_mock_tool', role: 'assistant', content: [], usage: { input_tokens: 14, output_tokens: 0 } } }),
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Appending a marigold entry.' } }),
    frame('content_block_stop', { index: 0 }),
    frame('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'append_to_note', input: {} } }),
    frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(0, cut) } }),
    frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: input.slice(cut) } }),
    frame('content_block_stop', { index: 1 }),
    frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }),
    frame('message_stop', {}),
  ];
}

function lastUserBlocks(body: any): any[] {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') return [];
  return typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content ?? [];
}

/** Picks the scripted response for a request: tool result in, closing text; trigger phrase in, tool call; else plain text. */
function choose(body: any): { sse: string[]; text: string } {
  const blocks = lastUserBlocks(body);
  if (blocks.some((b) => b.type === 'tool_result')) return { sse: textTurn(MOCK_AFTER_TOOL), text: MOCK_AFTER_TOOL };
  if (blocks.some((b) => b.type === 'text' && String(b.text).includes(TOOL_TRIGGER))) {
    return { sse: toolTurn(), text: '' };
  }
  return { sse: textTurn(MOCK_REPLY), text: MOCK_REPLY };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, requests: RecordedRequest[]): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  const body = await readBody(req);
  const key = req.headers['x-api-key'];
  requests.push({ path: req.url ?? '', apiKey: Array.isArray(key) ? key[0] : key, body });
  const { sse, text } = choose(body);
  if (body?.stream !== true) {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: body?.model ?? 'mock',
      content: [{ type: 'text', text: text || MOCK_REPLY }], stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 9 },
    }));
    return;
  }
  res.writeHead(200, { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const part of sse) {
    res.write(part);
    await new Promise((r) => setTimeout(r, 15));
  }
  res.end();
}

export async function startMockProvider(): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    handle(req, res, requests).catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
