# Human testing checklist — pre-tag verification

Used before cutting the 0.1.0 tag + submitting to the Obsidian
community plugins directory. Automated coverage (typecheck +
247 unit/integration tests + CDP desktop walkthrough) verifies
correctness of the wire format, prompt composition, and the
visible-on-desktop DOM. This checklist covers what desktop
automation can't reach: touch gestures, camera flow, share-sheet,
real API traffic, vault sync onboarding.

Run-time: ~45-60 minutes end to end. Each phase is independent;
skip what you've already verified in earlier passes.

## Phase A: Desktop sanity (5 min)

The minimum-viable-baseline. If this breaks, nothing else matters.

- [ ] Open Settings → Scribian. **Worker URL** + **Worker token**
      populated. Tap **Test connection**. Expected: green Notice
      "Worker OK (v...)".
- [ ] Open the chat pane from the ribbon icon. Empty state renders:
      "Your vault, on call." + 5 starter chips + sparkles icon.
- [ ] Tap "Capture this idea" chip. Composer pre-fills with the
      prompt text. Send a one-line idea. Verify streaming response
      with typing dots → text → vault-action badge ("📖 read N · ..."
      or "💭 no vault action").
- [ ] Verify the assistant message renders Markdown (bold, lists,
      code).
- [ ] Check `Scribian/Chats/<date>-…-<id>.md` was saved with
      frontmatter (model, usage, cost).

## Phase B: iPad / iPhone (15 min)

The real target. If this breaks, scribian breaks.

### Onboarding
- [ ] On a fresh device with Obsidian Sync, open the same vault.
      Verify scribian plugin auto-syncs into the device's plugins
      folder (give it ~30s).
- [ ] Enable scribian in Settings → Community plugins.
- [ ] Open chat pane. Verify: if URL+token already in vault data,
      no setup banner. If not, banner shows + tapping "Open
      settings" lands in scribian's tab.

### Setup URI flow (the "wife test")
- [ ] On desktop, construct
      `obsidian://scribian-setup?endpoint=<URL>&token=<TOKEN>`.
      AirDrop / Messages-to-self to the iPad.
- [ ] Tap the URI on the iPad. Confirmation modal opens. Verify
      endpoint shown verbatim + **token masked** (`abcd…wxyz`).
- [ ] Tap **Apply setup**. Notice fires; chat connects.

### Camera-first chip + image identification
- [ ] In chat empty state, tap "Identify + file" chip. iOS opens
      the camera (or photos picker on Mac/iPad without rear cam).
- [ ] Take/select a photo of an identifiable object (a plant, a
      receipt, a whiteboard).
- [ ] Send. Verify Claude (1) identifies the subject, (2) calls
      `find_related`, (3) proposes a `write_note` or
      `append_to_note` with a path that makes sense, (4) the diff
      card surfaces "Informed by: search: '...'".
- [ ] Approve via diff card OR swipe-right to approve. Verify the
      vault file actually lands. Verify haptic feedback fires on
      approve.

### Voice via iOS dictation
- [ ] Tap the composer textarea. Tap the mic icon on the iOS
      keyboard. Dictate a "remember this" prompt
      ("Remember that my dog Bailey is allergic to chicken").
- [ ] Verify the dictated text lands in the composer cleanly
      (autocapitalization, no transcription bugs Apple introduced).
- [ ] Send. Verify Claude calls `remember_fact`, diff card shows
      the proposed memory append, you approve, memory note grows.

### Apple Shortcut share-sheet
- [ ] In Safari, share an article via the Scribian Capture
      Shortcut (see `docs/apple-shortcut-recipe.md`).
- [ ] Verify: Obsidian foregrounds, "scribian: capturing…" Notice
      shows, then "scribian: captured → ..." OR "scribian: routed
      to ..." depending on whether find_related matched a target.
- [ ] Open the resulting note. Verify the body is a clean
      scribian-generated summary, not raw HTML.

## Phase C: Provider + security (10 min)

### OpenRouter swap (live smoke test)
- [ ] In settings, set **Active provider** to OpenRouter. Set
      **OpenRouter API key**. Select a model via fuzzy search
      (e.g. `anthropic/claude-sonnet-4-6`).
- [ ] Send a turn. Verify streaming works, response renders,
      cost surfaces in status row.
- [ ] Ask Claude to "search the web for X." Verify
      `web_search_tool_result` renders correctly (the translator
      converted `openrouter:web_search` → scribian-canonical).
- [ ] Send a turn with `find_related` query. Verify the vault
      tools still work through the WS bridge regardless of
      provider.

### Setup URI security
- [ ] Craft a malicious URI:
      `obsidian://scribian-setup?endpoint=http://evil.example&token=lol`.
      Open on iPad. Verify confirmation modal opens (does NOT
      silently rewrite settings).
- [ ] Tap **Cancel**. Verify previous configuration is intact.
- [ ] Try `obsidian://scribian-setup?endpoint=javascript:alert(1)&token=x`.
      Verify a "setup link invalid" Notice and NO modal.

## Phase D: Vault-action loop (15 min)

The locked positioning. If this doesn't feel right, ship is
premature.

### Read-then-propose
- [ ] Open a note in the vault you care about. In chat, ask:
      "What should I add to this?" (with the active-note chip
      attached via the paperclip).
- [ ] Verify the response: Claude reads the active note, possibly
      runs `find_related`, then PROPOSES a write via diff card.
      The diff card shows "Informed by: <Active>.md" in the trace.
- [ ] Reject the write. Verify it doesn't land + the rejected
      count shows up in the vault-action badge.

### Memory tool chain
- [ ] Send: "Remember that I prefer two-sentence paragraphs in
      my writing."
- [ ] Verify Claude calls `remember_fact`. Diff card shows the
      proposed append to your memory note. Approve.
- [ ] Open `Scribian/Memory.md`. Verify the fact is there.
- [ ] Start a new chat. Ask: "What writing preference do I
      have?" Verify Claude pulls from memory without `find_related`.

### Mid-turn write nudge
- [ ] Ask Claude a question where the answer "obviously" belongs
      in a specific note ("I'm planning a trip to Italy — what
      should I add to Travel/Italy.md?"). Sometimes Claude will
      answer in chat without proposing the write.
- [ ] Verify: under the assistant message you see a "Propose
      write to Travel/Italy.md" chip. Tap it. Composer pre-fills
      with a follow-up. Send. Verify Claude now emits the write.

### Tag-aware auto-pull
- [ ] Ask: "What do I have on #projects/scribian?" (or any tag
      you actually use).
- [ ] Verify the response references specific notes by path —
      the tag-context block surfaced the candidates without
      Claude needing to `find_related` first.

## Phase E: Polish + edge cases (10 min)

### Reconnect
- [ ] Background Obsidian for 30s. Foreground. Verify
      auto-reconnect succeeds within ~1s + status row reads
      "Connected".
- [ ] Toggle Airplane Mode on briefly. Verify "Disconnected"
      surface; turn it off; verify auto-reconnect.

### New chat
- [ ] In the middle of a conversation, tap the "new chat" icon.
      Verify empty state returns + new chips render.

### Starters live-edit
- [ ] In your vault, edit `Scribian/Starters.md` — change a chip
      label or add a new one. Save.
- [ ] In the chat pane, tap "new chat." Verify the chip row now
      reflects the edit (no plugin restart needed).

### Conversation search
- [ ] After several saved conversations, open command palette →
      "Scribian: Search conversations." Verify fuzzy search ranks
      by recency + match quality.
- [ ] Pick a result. Verify the saved markdown opens (resume-
      into-pane is a v2 follow-up — currently opens the file).

### Diff card swipe (touch only)
- [ ] Send a turn that produces a write proposal. **On the iPad**:
      swipe the diff card right (>70px). Verify approve fires +
      haptic.
- [ ] Trigger another write. Swipe left. Verify reject fires +
      pulse-haptic pattern.
- [ ] Trigger a third. Swipe right but release before crossing
      threshold. Verify card snaps back via the 180ms ease-out.

## Bug discovery → triage

For each unexpected behavior:

1. Note the scene + repro steps.
2. Capture: console errors (View → Toggle Developer Tools on
   desktop; `?vault=<name>` query for mobile dev console).
3. Capture: Logger output (`Scribian/Logs/<date>.md` if logs
   folder is configured).
4. Triage:
   - Reproducible + clear scope → file as a TODO in
     `campaigns/factory/notes/scribian-followups.md`.
   - Cosmetic + low-impact → ship anyway, fix post-tag.
   - Functional regression → block ship until fixed.

## Sign-off

When all five phases pass without functional regressions:

- [ ] Cut the 0.1.0 tag in scribian (`git tag -a 0.1.0 -m "..."`)
- [ ] Bump versions in `package.json` (root + plugin) AND
      `manifest.json` (must agree — pre-submission lint enforces)
- [ ] Build the release plugin (`pnpm --filter @scribian/plugin
      build`) and verify `dist/main.js` + `dist/styles.css` +
      `dist/manifest.json` are present.
- [ ] Submit via the Obsidian developer dashboard.
