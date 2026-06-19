# ADR 0007: Vault-as-memory -- a vault-native memory note with incremental upkeep

- Status: Accepted
- Date: 2026-06-19
- Deciders: Andrew Dunn

## Context

Long-term memory requires a place to live across sessions. The obvious
option is a provider's server-side memory feature: Anthropic, for
example, ships a memory tool that persists facts between conversations.
That approach is fast to integrate but fails the provider-agnostic spine
([ADR 0001](0001-direct-mode-over-cloudflare-worker.md)): it ties memory
to one vendor and is unavailable to self-hosted or local models routed
through OpenRouter. It is also opaque -- the user cannot see, edit, or
export what the model has learned about them.

The product steer was explicit: memory must be user-owned and
provider-agnostic.

## Decision

Long-term memory is a **single markdown note inside the vault**, at a
configurable path (`settings.memoryPath`, defaulting to
`Skald/Memory.md`). Its full contents are injected into the system
prompt as a `## Memory` section at session start. The model reads it
inline and can propose updates through the normal write tools; the user
approves any proposed change via a diff card.

Upkeep is incremental, not end-of-session. Every
`UPKEEP_EVERY_N_TURNS` (5) finalized turns, `proposeMemoryUpkeep()`
sends the last 6 messages plus the current memory body to the cheap
utility model ([ADR 0005](0005-model-cascade.md)) and asks for a
revised note. The proposal surfaces as a diff card. Nothing is written
silently.

Four safety guards protect the user's note:

1. **Cosmetic-diff suppression.** `normalizeNoteBody()` compares the
   proposal to the current note after normalizing whitespace. A
   proposal that is textually identical to the current note is dropped
   with no diff card, so the user is not nagged over formatting noise.
2. **Deletion guard.** `UPKEEP_MAX_DELETION_FRACTION = 0.40`: any
   proposal that removes more than 40% of the existing note's character
   count is rejected, logged as a warning, and never surfaced. A
   truncated or hallucinated response that would wipe the note returns
   null instead.
3. **Conversation-ID race guard.** The conversation ID is snapshotted
   at trigger time and re-checked before the write. If the user
   switched chats during the model call or the approval wait, the
   upkeep is aborted.
4. **In-flight gate.** A flag prevents two overlapping upkeep passes on
   the same note from running concurrently.

The `max_tokens` cap for the upkeep call is 8192. An earlier 512-token
cap truncated long notes and caused proposals that hit the deletion
guard; the higher cap fixes that.

## Why these choices

**Vault storage over server-side memory.** The vault note is portable,
inspectable, hand-editable, version-synced alongside every other note,
and readable by any model -- local, self-hosted, or cloud. Server-side
memory is none of those things.

**Incremental upkeep over end-of-session batch.** A small periodic call
keeps memory current as the conversation unfolds without requiring the
user to remember a "save memory" step at the end or running a heavy
batch pipeline separately.

**Cheap utility model for upkeep.** The upkeep task is well-defined
(summarize recent turns into the existing note) and does not require the
primary model's capability or context. Routing it to the utility model
keeps cost low, consistent with the model-cascade pattern in ADR 0005.

**Diff-card approval for every write.** Memory upkeep auto-edits a note
the user owns. Silent auto-writes on a user's personal notes are unsafe.
Every proposal goes through the same diff-card flow as any other
write tool, so the user sees and approves what changed.

**Deletion guard at 40%.** A hallucinated or truncated upkeep response
can return a much shorter note, silently destroying information. The
40% threshold catches these cases without blocking legitimate
condensation of a note that has grown verbose.

## Consequences

- The memory note is plain markdown under full user control -- editable,
  deletable, and synced by the vault like any other file.
- Upkeep costs a periodic cheap-model call per 5 turns when a session
  is active.
- The guards trade some automatic-ness for safety: a proposal that
  crosses the deletion threshold is silently dropped rather than
  surfaced for user judgment. In practice this catches data-destroying
  failures, not legitimate edits.
- Memory is not as seamless as opaque server memory, but it is
  transparent, portable, and vendor-neutral.

## Alternatives considered

- **Anthropic's server-side memory tool.** Rejected: vendor lock-in,
  unavailable to local and self-hosted models, not user-inspectable,
  conflicts with the provider-agnostic spine in ADR 0001.
- **Silent auto-writes with no approval.** Rejected: unsafe on a
  user-owned note; any truncation or model error silently destroys data.
- **No deletion guard.** Rejected: a truncated or hallucinated proposal
  could wipe the note; the guard is cheap and the failure mode it
  prevents is data loss.

## References

- [ADR 0001: Direct mode over the Cloudflare Worker](0001-direct-mode-over-cloudflare-worker.md)
- [ADR 0005: Model cascade](0005-model-cascade.md)
- `packages/plugin/src/memory-upkeep.ts`
- `packages/plugin/src/view/memory-upkeep-view.ts`
- `packages/plugin/src/memory-prompt.ts`
