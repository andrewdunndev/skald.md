// Phase 0 wire protocol: echo only. Grows to full Anthropic
// pass-through in phase 1.

export type ClientMessage =
  | { type: 'echo'; id: string; text: string }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'echoed'; id: string; text: string; received_at: number }
  | { type: 'pong' }
  | { type: 'error'; id?: string; error: string };
