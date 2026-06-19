/**
 * SkaldTransport: the shared interface that both WorkerTransport
 * (WebSocket → Cloudflare Worker) and DirectTransport (fetch → Anthropic
 * / OpenRouter) satisfy.
 *
 * The interface is intentionally narrow: ChatSession calls send() and
 * cancel(); the view calls connect(), isOpen(), and close(). Status
 * callbacks (onOpen / onClose / onError / onMessage) are wired once at
 * construction time via TransportHandlers.
 *
 * Keeping the interface here (separate from the concrete implementations)
 * lets tests and ChatSession import the type without pulling in Obsidian
 * or browser globals.
 */
import type { ClientMessage, ServerMessage } from '@skald/protocol';

export interface TransportHandlers {
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onMessage: (msg: ServerMessage) => void;
  onError: (err: string) => void;
}

export interface SkaldTransport {
  /** Open the connection (or mark as immediately ready for DirectTransport). */
  connect(): void;
  /** Send a protocol message to the remote or handle it locally. */
  send(msg: ClientMessage): void;
  /** Whether the transport is currently usable for sending. */
  isOpen(): boolean;
  /** Tear down the connection and release resources. */
  close(): void;
}
