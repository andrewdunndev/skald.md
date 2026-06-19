# Connection modes — architecture contract

## Declaring a mode

Connection modes are declared in `packages/plugin/src/settings.ts`:

```ts
export type ConnectionMode = 'direct' | 'worker';
```

Capability behavior for each mode lives in `packages/plugin/src/mode-capabilities.ts`
as an exhaustive switch on `ConnectionMode`. Adding a mode means:

1. Extend the `ConnectionMode` union in `settings.ts`.
2. Add a `case` to `modeCapabilities()` — the compiler errors on the missing arm.
3. Provide a transport that implements `SkaldTransport` (see `transport-interface.ts`).
4. Add the transport constructor arm to the `switch` in `view/connect-session.ts`.

No other files need mode-string comparisons. Every decision is expressed as a
`ModeCapabilities` field (`semanticSearch`, `usesWorker`, `banner`).

## Current modes

| Mode | Transport | Semantic search | Banner |
|------|-----------|-----------------|--------|
| `direct` | `DirectTransport` (fetch → Anthropic/OpenRouter) | no | none |
| `worker` | `Transport` (WebSocket → Cloudflare Worker) | yes | missing-config |

## Transports

Both transports implement `SkaldTransport` from `transport-interface.ts`.
`ChatSession` depends only on the interface; it is not aware of mode.

## Forward compatibility

A future `'remote'` mode (agent-host tier: phone connects to a self-hosted
long-running agent) rides this seam — add the union member, satisfy the
compiler in `modeCapabilities()`, provide a transport. Unknown mode strings
stored by a newer version are preserved on save via `_rawConnectionMode` in
`main.ts` and resolved to `'direct'` at runtime via `resolveConnectionMode()`.
