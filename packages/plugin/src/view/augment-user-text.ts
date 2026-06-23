import { TFile, type App } from 'obsidian';
import { buildTagContextBlock } from './tag-context';

/**
 * Neutralize the wrapper-closing delimiters inside an attached note's
 * body so a hostile note cannot break out of its `<file>`/`<context>`
 * wrapper and have its content read as top-level prompt text
 * (prompt-injection hardening).
 *
 * Only the *closing* tags need defanging — a stray `<context>` or
 * `<file …>` open tag is inert without a matching close. Matching is
 * deliberately liberal: case-insensitive and tolerant of internal
 * whitespace (e.g. `</ CONTEXT >`) so near-miss variants are caught
 * too. The replacement inserts a zero-width space (U+200B) right after
 * the opening `<`, which stops the run of characters from being read
 * as a delimiter while preserving the visible text for the model.
 */
export function escapeContextBody(content: string): string {
  return content.replace(/<(\s*\/\s*(?:context|file)\b[^>]*>)/gi, '<​$1');
}

/**
 * Wrap the user's text with `<context>` for explicitly @-attached
 * notes plus a `<tag-context>` block for any `#tag` mentions. The
 * tag-context is a cheap signal (paths only) so Claude can decide
 * whether to read_note on the hits — no token cost for full bodies
 * unless the model elects to read.
 *
 * Note bodies are run through {@link escapeContextBody} so an attached
 * note containing `</file>` / `</context>` cannot break out of its
 * wrapper.
 *
 * Returns the original text unchanged when there's nothing to add.
 */
export async function augmentUserText(
  app: App,
  text: string,
  pickedFiles: readonly TFile[],
): Promise<string> {
  const tagBlock = buildTagContextBlock(app, text);
  if (pickedFiles.length === 0 && !tagBlock) return text;

  const blocks: string[] = [];
  if (pickedFiles.length > 0) {
    blocks.push('<context>');
    for (const file of pickedFiles) {
      try {
        const content = await app.vault.read(file);
        blocks.push(`  <file path="${file.path}">`);
        blocks.push(escapeContextBody(content));
        blocks.push('  </file>');
      } catch {
        // skip unreadable
      }
    }
    blocks.push('</context>');
  }
  if (tagBlock) blocks.push(tagBlock);
  blocks.push('', text);
  return blocks.join('\n');
}
