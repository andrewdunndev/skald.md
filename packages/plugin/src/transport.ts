import type { ClientMessage, ServerMessage } from '@scribian/protocol';

export interface TransportHandlers {
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onMessage: (msg: ServerMessage) => void;
  onError: (err: string) => void;
}

export class Transport {
  private ws: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: TransportHandlers,
  ) {}

  connect(): void {
    try {
      // Token rides on Sec-WebSocket-Protocol — the only auth channel
      // available to a browser WebSocket. Worker validates and echoes
      // the chosen protocol in the 101 response.
      this.ws = new WebSocket(this.url, this.token);
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : 'open failed');
      return;
    }

    this.ws.addEventListener('open', () => this.handlers.onOpen());
    this.ws.addEventListener('close', (e) =>
      this.handlers.onClose(e.code, e.reason),
    );
    this.ws.addEventListener('error', () => this.handlers.onError('socket error'));
    this.ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        this.handlers.onMessage(msg);
      } catch {
        this.handlers.onError('parse error');
      }
    });
  }

  send(msg: ClientMessage): void {
    if (!this.isOpen()) return;
    this.ws!.send(JSON.stringify(msg));
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
