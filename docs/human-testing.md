# Human testing checklist -- pre-tag verification

Used before cutting the 0.1.0 tag + submitting to the Obsidian
community plugins directory. Unit tests (`pnpm test`) cover the wire
format, prompt composition and tool loop. The two automated layers
below cover what a desktop machine can reach; this checklist covers
what only a phone can.

Run-time: ~45-60 minutes end to end. Each phase is independent;
skip what you've already verified in earlier passes.

## What is automated

**L1: `pnpm test:e2e`** (`packages/e2e`, CI job `e2e-obsidian`).
wdio-obsidian-service installs the built plugin into a fixture vault
and drives real desktop Obsidian, twice: desktop layout, then
`emulateMobile` at 390x844. A local mock provider streams Anthropic
SSE so no key is needed. Covers: plugin load, chat pane, empty state
and starter chips, setup banner, active-note indicator, streamed
reply, tool call to approval diff card (approve writes, reject does
not), vault-action and idle badges, write nudges, New chat, settings
tab, and the mobile viewport having no horizontal overflow.

**L2: provider reachability.**
`pnpm check:cors` sends OPTIONS preflights from the three origins
skald runs under (`capacitor://localhost`, `http://localhost`,
`app://obsidian.md`) to Anthropic, OpenRouter and an OpenAI-compatible
base URL, and reports what each allows; it sends no key.
`pnpm smoke:live` (CI job `smoke-live`, default-branch and scheduled
pipelines only) makes one 20-token streamed request per provider from
masked variables and skips any provider whose variable is unset.

**Still human (iOS only):** WKWebView / `capacitor://` origin behaviour
on a real device, the Shortcut share sheet, dictation, camera and photo
picker, keyboard and safe-area layout, touch swipe on diff cards, and
background/resume. Items below are tagged:

- `[L1]` / `[L2]`: exercised by the automated layers; no need to repeat by hand.
- `[iOS]`: needs the phone.
- `[manual]`: not iOS-specific and not automated yet; check on desktop.

## Phase A: Desktop sanity (5 min)

Settings, empty state, chip fill and streaming are `[L1]`; the
Markdown rendering and saved-chat checks are `[manual]`.

The minimum-viable-baseline. If this breaks, nothing else matters.

- [ ] Open Settings -> Skald. **Provider** set to Anthropic.
      **API key** populated. Verify no error banner in the chat pane.
- [ ] Open the chat pane from the ribbon icon. Empty state renders:
      "Your vault, on call." + 5 starter chips + sparkles icon.
- [ ] Tap "Capture this idea" chip. Composer pre-fills with the
      prompt text. Send a one-line idea. Verify streaming response
      with typing dots -> text -> vault-action badge ("read N /..."
      or "no vault action").
- [ ] Verify the assistant message renders Markdown (bold, lists,
      code).
- [ ] Check `Skald/Chats/<date>-...-<id>.md` was saved with
      frontmatter (model, usage, cost).

## Phase B: iPad / iPhone (15 min)

The real target. If this breaks, skald breaks.

### Onboarding `[iOS]`
- [ ] On a fresh device with Obsidian Sync, open the same vault.
      Verify skald plugin auto-syncs into the device's plugins
      folder (give it ~30s).
- [ ] Enable skald in Settings -> Community plugins.
- [ ] Open chat pane. If the API key is already in vault data
      (synced from desktop), no setup banner -- chat is ready
      immediately. If not, banner shows + tapping "Open settings"
      lands in skald's tab.

### WKWebView origin, keyboard, safe area `[iOS]`
- [ ] Send a turn with the Anthropic key. Verify it streams (this
      proves the `capacitor://localhost` origin is accepted end to
      end; `pnpm check:cors` only proves the preflight).
- [ ] Focus the composer. Verify the keyboard does not cover the
      composer and the send button stays reachable.
- [ ] Rotate the device. Verify the composer clears the home
      indicator and no content sits under the notch.

### Camera-first chip + image identification `[iOS]`
- [ ] In chat empty state, tap "Identify + file" chip. iOS opens
      the camera (or photos picker on Mac/iPad without rear cam).
- [ ] Take/select a photo of an identifiable object (a plant, a
      receipt, a whiteboard).
- [ ] Send. Verify Claude (1) identifies the subject, (2) calls
      `search_vault`, (3) proposes a `write_note` or
      `append_to_note` with a path that makes sense, (4) the diff
      card surfaces "Informed by: search: '...'".
- [ ] Approve via diff card OR swipe-right to approve. Verify the
      vault file actually lands. Verify haptic feedback fires on
      approve.

### Voice via iOS dictation `[iOS]`
- [ ] Tap the composer textarea. Tap the mic icon on the iOS
      keyboard. Dictate a "remember this" prompt
      ("Remember that my dog Bailey is allergic to chicken").
- [ ] Verify the dictated text lands in the composer cleanly
      (autocapitalization, no transcription bugs Apple introduced).
- [ ] Send. Verify Claude calls `remember_fact`, diff card shows
      the proposed memory append, you approve, memory note grows.

### Apple Shortcut share-sheet `[iOS]`
- [ ] In Safari, share an article via the Skald Capture
      Shortcut (see `docs/apple-shortcut-recipe.md`).
- [ ] Verify: Obsidian foregrounds, "skald: capturing..." Notice
      shows, then "skald: captured -> ..." (captures always land
      in the captures folder).
- [ ] Open the resulting note. Verify the body is a clean
      skald-generated summary, not raw HTML.

## Phase C: Provider + security (10 min)

### OpenRouter swap (live smoke test) `[L2]` streaming, `[manual]` web search
- [ ] In settings, set **Provider** to OpenRouter. Set
      **OpenRouter API key**. Select a model via fuzzy search
      (e.g. `anthropic/claude-sonnet-4-6`).
- [ ] Send a turn. Verify streaming works, response renders,
      cost surfaces in status row.
- [ ] Ask Claude to "search the web for X." Verify
      `web_search_tool_result` renders correctly (the translator
      converted `openrouter:web_search` -> skald-canonical).

## Phase D: Vault-action loop (15 min)

The locked positioning. If this doesn't feel right, ship is
premature.

### Read-then-propose `[L1]` diff card and reject, `[manual]` the rest
- [ ] Open a note in the vault you care about. In chat, ask:
      "What should I add to this?" (with the active-note chip
      attached via the paperclip).
- [ ] Verify the response: Claude reads the active note, possibly
      runs `search_vault`, then PROPOSES a write via diff card.
      The diff card shows "Informed by: <Active>.md" in the trace.
- [ ] Reject the write. Verify it doesn't land + the rejected
      count shows up in the vault-action badge.

### Memory tool chain `[manual]`
- [ ] Send: "Remember that I prefer two-sentence paragraphs in
      my writing."
- [ ] Verify Claude calls `remember_fact`. Diff card shows the
      proposed append to your memory note. Approve.
- [ ] Open `Skald/Memory.md`. Verify the fact is there.
- [ ] Start a new chat. Ask: "What writing preference do I
      have?" Verify Claude pulls from memory without a search call.

### Mid-turn write nudge `[L1]` chip rendering, `[manual]` follow-up send
- [ ] Ask Claude a question where the answer "obviously" belongs
      in a specific note ("I'm planning a trip to Italy -- what
      should I add to Travel/Italy.md?"). Sometimes Claude will
      answer in chat without proposing the write.
- [ ] Verify: under the assistant message you see a "Propose
      write to Travel/Italy.md" chip. Tap it. Composer pre-fills
      with a follow-up. Send. Verify Claude now emits the write.

### Tag-aware auto-pull `[manual]`
- [ ] Ask: "What do I have on #projects/skald?" (or any tag
      you actually use).
- [ ] Verify the response references specific notes by path --
      the tag-context block surfaced the candidates without
      a search call.

## Phase E: Polish + edge cases (10 min)

### Reconnect `[iOS]`
- [ ] Background Obsidian for 30s. Foreground. Verify
      auto-reconnect succeeds within ~1s + status row reads
      "Connected".
- [ ] Toggle Airplane Mode on briefly. Verify "Disconnected"
      surface; turn it off; verify auto-reconnect.

### New chat `[L1]`
- [ ] In the middle of a conversation, tap the "new chat" icon.
      Verify empty state returns + new chips render.

### Starters live-edit `[manual]`
- [ ] In your vault, edit `Skald/Starters.md` -- change a chip
      label or add a new one. Save.
- [ ] In the chat pane, tap "new chat." Verify the chip row now
      reflects the edit (no plugin restart needed).

### Conversation search `[manual]`
- [ ] After several saved conversations, open command palette ->
      "Skald: Search conversations." Verify fuzzy search ranks
      by recency + match quality.
- [ ] Pick a result. Verify the saved markdown opens (resume-
      into-pane is a v2 follow-up -- currently opens the file).

### Diff card swipe (touch only) `[iOS]`
- [ ] Send a turn that produces a write proposal. **On the iPad**:
      swipe the diff card right (>70px). Verify approve fires +
      haptic.
- [ ] Trigger another write. Swipe left. Verify reject fires +
      pulse-haptic pattern.
- [ ] Trigger a third. Swipe right but release before crossing
      threshold. Verify card snaps back via the 180ms ease-out.

## Bug discovery -> triage

For each unexpected behavior:

1. Note the scene + repro steps.
2. Capture: console errors (View -> Toggle Developer Tools on
   desktop; `?vault=<name>` query for mobile dev console).
3. Capture: Logger output (`Skald/Logs/<date>.md` if logs
   folder is configured).
4. Triage:
   - Reproducible + clear scope -> file as a TODO in
     `campaigns/factory/notes/skald-followups.md`.
   - Cosmetic + low-impact -> ship anyway, fix post-tag.
   - Functional regression -> block ship until fixed.

## Sign-off

When all five phases pass without functional regressions:

- [ ] Cut the 0.1.0 tag in skald (`git tag -a 0.1.0 -m "..."`)
- [ ] Bump versions in `package.json` (root + plugin) AND
      `manifest.json` (must agree -- pre-submission lint enforces)
- [ ] Build the release plugin (`pnpm --filter @skald/plugin
      build`) and verify `dist/main.js` + `dist/styles.css` +
      `dist/manifest.json` are present.
- [ ] Submit via the Obsidian developer dashboard.
