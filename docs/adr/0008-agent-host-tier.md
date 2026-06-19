# ADR 0008: Agent-host tier for the heavy path

- Status: Proposed (exploring -- no committed timeline)
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

[ADR 0001](0001-direct-mode-over-cloudflare-worker.md) makes Skald
direct-only: the plugin spends the user's tokens per query and runs
entirely on the device, including mobile. That is the right default and
covers most use. It has ceilings, though, that no amount of on-device
cleverness removes:

- **Always-on work.** Continuous background indexing, scheduled vault
  maintenance, and long-running agentic tasks want a process that is up
  when the phone is not.
- **Real semantic recall.** Maintaining an embeddings index over a large
  vault is work that belongs on a host, not recomputed on a phone (see
  [ADR 0002](0002-lexical-retrieval-llm-reranking.md) for why we do not
  carry a vector index in the plugin).
- **Key and compute off the device.** Some users want the API key, and
  the heavier inference, somewhere other than a synced `data.json`.
- **Local and self-hosted models.** A persistent host can run or front
  local models directly, which is awkward to do from inside Obsidian's
  renderer.

The token-reduction and accuracy work already in the plugin (ADRs
0002-0007) is what makes the direct tier economical. The heavy tier is
not a replacement for that; it is a second deployment shape for people
who want infrastructure.

The Cloudflare Worker was the previous answer to "the heavy path" and
ADR 0001 removed it. A thin edge relay is the wrong substrate: the
capabilities above need a persistent agent runtime with a filesystem,
long-lived state, and first-class tool use, not stateless edge
functions.

## Decision

Direction (not yet a committed design): the heavy path is an
**agent-host** -- a self-hosted, persistent, headless companion that the
phone connects to. It is built on the **Claude Agent SDK / `claude -p`**
so the agent brain matches the plugin's, rather than a bespoke server.
The plugin reaches it through a reintroduced `'remote'` connection mode
and a transport built for that purpose.

This is recorded now to set direction, not to schedule work. It is
marked exploring; there are no dates.

Shape we are leaning toward (subject to the design spike):

- A long-running process the user hosts (their own box, a home server),
  exposing an authenticated endpoint the plugin connects to.
- The agent runtime is the Claude Agent SDK / `claude -p`, with vault
  access and tool use on the host side.
- Reach from a phone without manual NAT work, via a tunnel such as
  Cloudflare Tunnel or Tailscale (transport-level, not a CF Worker).
- The provider-agnostic spine holds: local and self-hosted models stay
  first-class, not an afterthought.

This supersedes the Cloudflare Worker as the project's "heavy tier"
concept.

## Consequences

- The connection-mode seam removed in ADR 0001 will be reintroduced when
  this is designed, built for the `'remote'` case rather than retrofitted
  from the Worker era.
- A new threat model is required. A self-hosted, network-reachable agent
  with vault read/write and an API key is a materially larger surface
  than an on-device plugin. Auth, transport security, and exposure need
  their own ADR before any code lands.
- Capability parity matters. Anything the agent-host gains (semantic
  recall, background indexing) should degrade cleanly to the direct
  tier's behavior, not fork the product into two incompatible halves.
- Packaging and operability become real concerns (how a non-expert
  stands up and updates a host), and will gate whether this ships beyond
  power users.

## Open questions

- Transport and protocol between plugin and host (WebSocket, HTTP/SSE,
  something the SDK already speaks).
- Authentication and device pairing; per-device revocation.
- Discovery and reachability across NAT without burdening the user.
- Which capabilities live only on the host versus mirrored on-device.
- Packaging: container, single binary, or guided install.

When these are answered, this ADR is superseded by one or more concrete
ADRs (transport, auth/threat model, packaging).

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0002: Lexical retrieval + LLM reranking over vector search](0002-lexical-retrieval-llm-reranking.md)
