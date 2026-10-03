# iOS share-sheet capture

Share text or a link from any iOS app to an Apple Shortcut, and Skald
turns it into a note in your captures folder. Capture is text only: a
shared URL arrives as text, and Claude does not open it.

iOS can't make an Obsidian plugin a share-sheet target, so a Shortcut
receives the share and opens an `obsidian://skald-capture` link. Skald
sends the text to your provider and writes the reply to
`Skald/Captures/YYYY-MM-DD-<slug>.md`.

## Setup (one-time)

1. **Get chat working first**, with your API key set in Settings →
   Skald.
2. **Turn capture on.** Settings → Skald → Advanced → Share-sheet
   capture → **Allow share-sheet capture**. It is off by default:
   while off, the link only shows a Notice.
3. **Build the Shortcut** on your iPhone or iPad:
   1. In **Shortcuts**, tap **+** and name it **Skald Capture**.
   2. Under (i), turn on **Show in Share Sheet** and pick **URLs**
      and **Text**.
   3. Add **Receive Input from Share Sheet**.
   4. Add **URL Encode** on the Shortcut Input.
   5. Add **URL** with
      `obsidian://skald-capture?vault=<vault>&payload=<encoded>`,
      with your vault name and the encoded text as a magic variable.
      Add `&silent=true` to skip opening the note.
   6. Add **Open URLs**.

Test it from Safari: share → **Skald Capture**. A "capturing…" Notice
appears, then the note opens. If nothing happens, check that the
vault in the link is the one Obsidian has open.

## Custom prompt

To replace the built-in prompt, write a note (frontmatter is
stripped) and enter its path under Share-sheet capture → **Custom
capture prompt**. The shared text follows it after a `---` line.

## Security

Capture writes its note without an approval card, and any app or web
page that can open `obsidian://` links can fire it. That is why it
ships off. When on, it is limited to 5 captures a minute, and the log
records only that a capture ran, never the content. Shared text goes
to your provider the same way chat does. Very long shares can exceed
what iOS allows in a link.
