import { TFile, type App } from 'obsidian';
import { buildTagContextBlock } from './tag-context';

/**
 * Wrap the user's text with `<context>` for explicitly @-attached
 * notes plus a `<tag-context>` block for any `#tag` mentions. The
 * tag-context is a cheap signal (paths only) so Claude can decide
 * whether to read_note on the hits — no token cost for full bodies
 * unless the model elects to read.
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
        blocks.push(content);
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
