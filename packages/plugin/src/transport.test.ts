/**
 * Transport (WorkerTransport) unit tests.
 *
 * Mocks the WebSocket constructor so no real network connections are made.
 * Covers: connect wires handlers and opens, onMessage parses JSON,
 * malformed JSON doesn't throw, send() when open vs not open, close()
 * prevents reconnect, unexpected close schedules reconnect (fake timers),
 * auth subprotocol/token wiring, and the error path.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from '@skald/protocol';
import { Transport } from './transport';

// ── WebSocket mock ─────────────────────────────────────────────────────────

interface MockWsInstance {
  readyState: number;
  protocol: string;
  listeners: Map<string, ((e: unknown) => void)[]>;
  sent: string[];
  addEventListener(type: string, cb: (e: unknown) => void): void;
  send(data: string): void;
  close(): void;
  /** Test helper: fire an event on this mock socket. */
  emit(type: string, event?: unknown): void;
}

function makeMockWs(url: string, protocol: string): MockWsInstance {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const sent: string[] = [];
  let readyState: number = WebSocket.CONNECTING;

  const ws: MockWsInstance = {
    get readyState() {
      return readyState;
    },
    protocol,
    listeners,
    sent,
    addEventListener(type: string, cb: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(cb);
    },
    send(data: string) {
      sent.push(data);
    },
    close() {
      readyState = WebSocket.CLOSED;
    },
    emit(type: string, event: unknown = {}) {
      for (const cb of listeners.get(type) ?? []) cb(event);
    },
  };

  // Make it open synchronously when 'open' listeners are registered,
  // unless the test overrides by calling emit('close') first.
  Object.defineProperty(ws, 'readyState', {
    get() {
      return readyState;
    },
    set(v: number) {
      readyState = v;
    },
  });

  return ws;
}

// ── helpers ─────────────────────────────────────────────────────────────────

let lastCreatedWs: MockWsInstance | null = null;
let WsMock: ReturnType<typeof vi.fn>;

function makeHandlers() {
  const messages: ServerMessage[] = [];
  return {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn((m: ServerMessage) => messages.push(m)),
    onError: vi.fn(),
    messages,
  };
}

function makeTransport(
  url = 'wss://test.example.com/ws',
  token = 'tok-test',
) {
  const handlers = makeHandlers();
  const transport = new Transport(url, token, handlers);
  return { transport, handlers };
}

// ── setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  lastCreatedWs = null;
  WsMock = vi.fn((url: string, protocol: string) => {
    const ws = makeMockWs(url, protocol);
    lastCreatedWs = ws;
    return ws;
  });
  // Add WebSocket static readyState constants so isOpen() comparisons work.
  Object.assign(WsMock, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  });
  vi.stubGlobal('WebSocket', WsMock);
  // Transport uses window.setTimeout for the reconnect backoff timer.
  // Proxy through globalThis so vi.useFakeTimers() intercepts it.
  vi.stubGlobal('window', {
    get setTimeout() { return globalThis.setTimeout; },
    get clearTimeout() { return globalThis.clearTimeout; },
  });
  // Transport installs a visibilitychange listener on document. Stub it so
  // tests don't fail in the jsdom-less vitest environment.
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── connect ────────────────────────────────────────────────────────────────

describe('Transport.connect', () => {
  it('constructs a WebSocket with the configured URL', () => {
    const { transport } = makeTransport('wss://worker.example.com');
    transport.connect();
    expect(WsMock).toHaveBeenCalledWith('wss://worker.example.com', expect.any(String));
  });

  it('passes the token as the WebSocket subprotocol', () => {
    const { transport } = makeTransport('wss://x', 'my-secret-token');
    transport.connect();
    expect(WsMock).toHaveBeenCalledWith('wss://x', 'my-secret-token');
  });

  it('fires onOpen when the socket emits open', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;
    ws.emit('open');
    expect(handlers.onOpen).toHaveBeenCalledOnce();
  });

  it('is not open before the socket emits open', () => {
    const { transport } = makeTransport();
    transport.connect();
    expect(transport.isOpen()).toBe(false);
  });

  it('reports isOpen() true after open event and readyState=OPEN', () => {
    const { transport } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs! as unknown as { readyState: number };
    ws.readyState = WebSocket.OPEN;
    expect(transport.isOpen()).toBe(true);
  });
});

// ── onMessage ─────────────────────────────────────────────────────────────

describe('Transport onMessage handler', () => {
  it('parses valid ServerMessage JSON and forwards to onMessage', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;
    const msg: ServerMessage = { type: 'pong' };
    ws.emit('message', { data: JSON.stringify(msg) });
    expect(handlers.onMessage).toHaveBeenCalledOnce();
    expect(handlers.messages[0]).toEqual(msg);
  });

  it('parses a done message with full fields', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;
    const done: ServerMessage = {
      type: 'done',
      id: 'turn1',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
      provider: 'anthropic',
    };
    ws.emit('message', { data: JSON.stringify(done) });
    expect(handlers.messages[0]).toEqual(done);
  });

  it('does not throw and calls onError for malformed JSON', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;
    ws.emit('message', { data: 'not-json{{' });
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledOnce();
    expect(handlers.onError.mock.calls[0][0]).toMatch(/parse error/i);
  });
});

// ── send ──────────────────────────────────────────────────────────────────

describe('Transport.send', () => {
  it('sends serialized JSON when the socket is open', () => {
    const { transport } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs! as unknown as { readyState: number } & MockWsInstance;
    ws.readyState = WebSocket.OPEN;
    transport.send({ type: 'ping' });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'ping' });
  });

  it('is a no-op when the socket is not open', () => {
    const { transport } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs! as MockWsInstance;
    // readyState defaults to CONNECTING (not OPEN); send should be dropped.
    transport.send({ type: 'ping' });
    expect(ws.sent).toHaveLength(0);
  });

  it('does not throw when called before connect()', () => {
    const { transport } = makeTransport();
    expect(() => transport.send({ type: 'ping' })).not.toThrow();
  });
});

// ── close ─────────────────────────────────────────────────────────────────

describe('Transport.close', () => {
  it('fires onClose and prevents reconnect on unexpected close after close()', () => {
    vi.useFakeTimers();
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;

    transport.close();
    // Simulate the WebSocket closing after close() was called.
    ws.emit('close', { code: 1000, reason: 'normal' });

    // scheduleReconnect should NOT run after an intentional close.
    vi.runAllTimers();
    // Only one WebSocket should have been created.
    expect(WsMock).toHaveBeenCalledTimes(1);
    // onClose was fired by the explicit close() + potential WS close event.
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

// ── reconnect ─────────────────────────────────────────────────────────────

describe('Transport reconnect', () => {
  it('schedules a reconnect when the socket closes unexpectedly', () => {
    vi.useFakeTimers();
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;
    ws.emit('open');

    // Simulate unexpected close (not triggered by transport.close()).
    ws.emit('close', { code: 1006, reason: 'abnormal' });
    expect(handlers.onClose).toHaveBeenCalledWith(1006, 'abnormal');

    // Advance past the backoff delay (first attempt = 1000 ms base).
    vi.runAllTimers();

    // A second WebSocket should have been constructed.
    expect(WsMock).toHaveBeenCalledTimes(2);
  });

  it('resets reconnect attempt counter on successful open', () => {
    vi.useFakeTimers();
    const { transport } = makeTransport();
    transport.connect();
    let ws = lastCreatedWs!;
    ws.emit('open');

    // Force a drop then reconnect.
    ws.emit('close', { code: 1006, reason: '' });
    vi.runAllTimers();

    ws = lastCreatedWs!;
    ws.emit('open');

    // Another drop should still schedule a reconnect (attempt was reset to 0).
    ws.emit('close', { code: 1006, reason: '' });
    vi.runAllTimers();
    expect(WsMock).toHaveBeenCalledTimes(3);
  });
});

// ── error path ─────────────────────────────────────────────────────────────

describe('Transport error path', () => {
  it('calls onError when the socket emits an error event', () => {
    const { transport, handlers } = makeTransport();
    transport.connect();
    const ws = lastCreatedWs!;
    ws.emit('error', {});
    expect(handlers.onError).toHaveBeenCalledWith('socket error');
  });

  it('calls onError when the WebSocket constructor throws', () => {
    WsMock = vi.fn(() => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('WebSocket', WsMock);

    vi.useFakeTimers();
    const { transport, handlers } = makeTransport();
    transport.connect();
    expect(handlers.onError).toHaveBeenCalledWith('connection refused');
  });
});
