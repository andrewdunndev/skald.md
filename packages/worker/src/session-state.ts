/**
 * Shared types for in-memory state the Durable Object maintains during
 * its active lifetime. Lost across hibernation cycles — these are for
 * "what happened recently" diagnostics, not durable audit logs (which
 * go to wrangler tail / the plugin's logsFolder).
 */

export interface AuditEvent {
  ts: number; // unix ms
  type: 'chat' | 'tool';
  label: string; // token label or 'plugin' / 'anon'
  detail: string;
  // Provider that served this event. Only populated for chat events
  // (tool routes are provider-independent). Phase 5+.
  provider?: 'anthropic' | 'openrouter';
}
