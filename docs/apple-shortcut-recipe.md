# Apple Shortcut recipe for scribian capture

Step-by-step instructions to build the Shortcut that powers
`obsidian://scribian-capture`. Until the `.shortcut` iCloud share
link lands in the repo (issue: distribution-prep), this is the
canonical build recipe.

The Shortcut sits in your iOS share sheet. When triggered from
Safari (URL/text), Photos (image), or any text-bearing app, it
URL-encodes the input and opens an `obsidian://scribian-capture`
URL. scribian's protocol handler picks it up and runs the capture
flow.

## Build it once

On iPhone or iPad:

1. Open the **Shortcuts** app.
2. Tap **+** (top right) → "New Shortcut."
3. Rename the shortcut: tap the title bar, type **Scribian
   Capture**. Tap a color/icon if you want.
4. Tap the (i) icon at the bottom → **Show in Share Sheet** ON.
5. Under "Share Sheet Types" select: **URLs**, **Text**, **Images**
   (uncheck the others; uncheck "Media" if it appears separately).
6. Done with settings — tap "Done" to return to the action editor.

Now add the actions, in order:

### 1. Receive shared input

Tap the **+** in the action area:

- Add action: **Receive Input from Share Sheet**
- Configure: input types **Anything** (we'll branch on type later).

### 2. Set the vault name variable

- Add action: **Text** (search "text" in the action picker).
- In the text field, type your Obsidian vault name (the folder
  Obsidian shows in the vault picker, e.g. `aa`).
- Add action: **Set Variable** → name it **vault**, value the
  previous Text action's output.

### 3. Detect the input kind

Add action: **If** (search "if").

- Condition: **Shortcut Input** → **has any value**
- Inside the If branch, add: **Get Type of Shortcut Input**
- Below that, add another **If**:
  - Condition: **Shortcut Input** → **contains** → `http`
    (a crude URL detector; refine later if needed)
  - Set Variable **kind** to `url`
  - Otherwise: Set Variable **kind** to `text`

For image support, add a parallel branch on the outer If:
- Condition: **Shortcut Input** → **is of type** → **Image**
  - Save the image to a vault folder via the next step (4), and
    set Variable **kind** to `image`.

### 4. (Image branch only) Save image into the vault inbox

Apple Shortcuts can write to Files.app folders — Obsidian iOS
vaults live there. Use the **Save File** action:

- Action: **Save File**
- Destination: Browse → On My iPad/iPhone → Obsidian → `<vault>` →
  `scribian` → `inbox`
- Filename: timestamp + `.jpg` (use the "Current Date" magic
  variable formatted as `yyyy-MM-dd-HH-mm-ss`)
- After saving, get the file's vault-relative path (e.g.
  `scribian/inbox/2026-05-14-15-30-00.jpg`) and store in Variable
  **payload**.

### 5. URL-encode the payload (text/URL branches)

For the text + URL branches, the payload is the share input. Add:

- Action: **URL Encode**
- Input: **Shortcut Input**
- Output goes into Variable **payload**.

### 6. Build the obsidian:// URL

Add action: **URL** (search "URL").

Type the URL with magic-variable substitution:

```
obsidian://scribian-capture?vault=<vault>&kind=<kind>&payload=<payload>
```

Replace `<vault>`, `<kind>`, `<payload>` with the magic variables
of the same names by tapping the variable button (right side of
the keyboard).

### 7. Open the URL

Add action: **Open URLs**.
- URL input: the URL from step 6.

## Test it

1. Save the Shortcut (tap Done top-right).
2. Open Safari, go to any page, tap share → swipe to find
   **Scribian Capture** → tap.
3. Obsidian should foreground (or open if it wasn't running) and
   scribian's protocol handler should fire. A "scribian:
   capturing…" Notice appears, then "scribian: captured →
   Scribian/Captures/<date>-<slug>.md" when done.

If it doesn't fire:
- Check Obsidian is the foreground vault matches `<vault>` in the
  URL (use `obsidian://open?vault=<name>` first if the wrong vault
  is active).
- Check the plugin is enabled in Settings → Community plugins.
- Check the Worker URL + token are configured in Settings →
  Scribian → Worker.

## Sharing the Shortcut

Once it works, tap the (i) icon → Share → "Share Shortcut Link" to
generate an iCloud share URL. Send that URL to other devices /
family members; they tap it once and add the Shortcut to their
own Shortcuts app.

(Until the project ships a signed `.shortcut` file in the repo,
this user-generated iCloud link is the distribution path.)

## What this Shortcut does NOT do (yet)

- **Long-content staging.** iOS URL schemes have a practical
  ~2000-char ceiling. For long-form Safari Reader output, this
  Shortcut should write the content to a staging file in the vault
  and pass the path instead of the content. Future iteration.
- **PDF capture.** PDFs from share-sheet are valid (`kind=pdf`)
  per the protocol handler, but the Shortcut would need a PDF
  branch that saves to `scribian/inbox/`. Not built yet.
- **Base64 fallback.** When content has special characters that
  break URL encoding, pass `b64=true` and base64-encode the
  payload. Not built yet.
