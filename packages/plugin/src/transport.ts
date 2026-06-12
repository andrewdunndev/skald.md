/**
 * WorkerTransport: WebSocket-based transport to the Cloudflare Worker.
 *
 * Exponential backoff for unexpected disconnects, capped at 30 s. Mobile
 * WebSockets get killed when the app backgrounds; backoff + visibility-
 * change handling pulls the connection back up without user intervention.
 *
 * Implements ScribianTransport so it can be used interchangeably with
 * DirectTransport inside ChatSession and view.ts.
 */
import type { ClientMessage } from '@scribian/protocol';
import type { ScribianTransport, TransportHandlers } from './transport-interface';

export type { ScribianTransport, TransportHandlers } from './transport-interface';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 8;

export class Transport implements ScribianTransport {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: TransportHandlers,
  ) {}

  connect(): void {
    this.closed = false;
    this.cancelReconnect();
    this.openSocket();
    this.installVisibilityListener();
  }

  send(msg: ClientMessage): void {
    if (!this.isOpen()) return;
    this.ws!.send(JSON.stringify(msg));
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    this.cancelReconnect();
    this.removeVisibilityListener();
    this.ws?.close();
    this.ws = null;
  }

  private openSocket(): void {
    try {
      this.ws = new WebSocket(this.url, this.token);
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err.message : 'open failed');
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.handlers.onOpen();
    });
    this.ws.addEventListener('close', (e) => {
      this.handlers.onClose(e.code, e.reason);
      if (!this.closed) this.scheduleReconnect();
    });
    this.ws.addEventListener('error', () => this.handlers.onError('socket error'));
    this.ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data as string) as import('@scribian/protocol').ServerMessage;
        this.handlers.onMessage(msg);
      } catch {
        this.handlers.onError('parse error');
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }

  private installVisibilityListener(): void {
    if (this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && !this.isOpen() && !this.closed) {
        // Foregrounded after a likely-suspended session — try immediately.
        this.cancelReconnect();
        this.openSocket();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private removeVisibilityListener(): void {
    if (!this.visibilityHandler) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
  }
}
