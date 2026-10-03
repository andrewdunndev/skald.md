/**
 * Slash commands (phase 9a).
 *
 * A slash command is a markdown note whose body is a prompt
 * template. Users author them in a configurable folder (default
 * Skald/Commands/) and pick one from a modal triggered by the
 * "Skald: Run command" command-palette entry. The selected
 * template is variable-expanded and dropped into the chat input
 * for the user to review + send.
 *
 * Runs from a command-palette modal. Templating is Mustache-flavored
 * without logic:
 * `{{active_note}}`, `{{active_note.title}}`, `{{date}}`. Default
 * values via `{{var|default}}`.
 *
 * Markdown-as-config rationale: commands sync via vault sync, work
 * across devices for free, are version-controlled with the user's
 * vault, and let power users author their own without a plugin
 * settings UI for each new command.
 */

import {
  App,
  Notice,
  SuggestModal,
  TFile,
  normalizePath,
} from 'obsidian';

export interface SlashCommand {
  /** Command id derived from the filename (basename without `.md`). */
  id: string;
  /** Path to the source note. Stable across reloads as long as the
   * filename doesn't change. */
  path: string;
  /** Display name from frontmatter `name:`, falls back to id. */
  name: string;
  /** Short description from frontmatter `description:`. */
  description: string;
  /** Whether to auto-attach the active note as context. */
  includesActiveNote: boolean;
  /** The body of the note (frontmatter stripped) used as the
   * Mustache template. */
  template: string;
}

/**
 * Walk the configured commands folder, parse each markdown note's
 * frontmatter + body into a SlashCommand. Tolerates missing fields
 * (defaults to sensible values) so users can author bare-body
 * commands.
 */
export async function loadSlashCommands(
  app: App,
  folder: string,
): Promise<SlashCommand[]> {
  const f = folder.trim();
  if (!f) return [];
  const folderPath = normalizePath(f).replace(/\/$/, '');
  const out: SlashCommand[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(folderPath + '/')) continue;
    try {
      const body = await app.vault.cachedRead(file);
      out.push(parseCommand(file, body));
    } catch {
      // skip unreadable
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function parseCommand(file: TFile, body: string): SlashCommand {
  const { frontmatter, content } = splitFrontmatter(body);
  return {
    id: file.basename,
    path: file.path,
    name: frontmatter.name ?? file.basename,
    description: frontmatter.description ?? '',
    includesActiveNote:
      String(frontmatter.includes_active_note ?? '').toLowerCase() === 'true',
    template: content.trim(),
  };
}

/**
 * Render a command template into a final prompt string. Substitutes:
 *   - {{active_note}}           → current note wrapped in
 *                                  <context><file/></context>
 *   - {{active_note.title}}     → current note's basename
 *   - {{date}}                  → today as YYYY-MM-DD
 *   - {{var|default}}           → default (no args UI in v1)
 *
 * Unknown variables resolve to an empty string with a console warning
 * — we don't want bad templates to silently leave `{{foo}}` literals
 * in the prompt.
 */
/** Max characters injected via `{{active_note}}`. ~80 KB which is
 * ~20K tokens — covers normal note sizes (most notes are well
 * under 10 KB) while bounding the cost surface for the pathological
 * case of a 1 MB megafile. When truncated, a marker line tells
 * Claude exactly what happened. */
export const ACTIVE_NOTE_INJECT_MAX_CHARS = 80_000;

export async function renderCommand(
  app: App,
  cmd: SlashCommand,
): Promise<string> {
  const activeFile = app.workspace.getActiveFile();
  const activeBody = activeFile
    ? await app.vault.cachedRead(activeFile).catch(() => '')
    : '';

  const variables: Record<string, string> = {
    'active_note.title': activeFile?.basename ?? '',
    date: new Date().toISOString().slice(0, 10),
  };
  // active_note is special — it wraps in the <context><file/> shape
  // the existing chat input uses for @-attached notes so Claude sees
  // the same structure whether the user attaches or invokes a command.
  if (activeFile && cmd.includesActiveNote && activeBody) {
    const { body, truncatedAt } = truncateForInject(activeBody);
    const truncMarker = truncatedAt
      ? `\n\n[skald: truncated at ${truncatedAt} chars; original was ${activeBody.length} chars]`
      : '';
    variables.active_note =
      `<context>\n  <file path="${activeFile.path}">\n${body}${truncMarker}\n  </file>\n</context>`;
  } else {
    variables.active_note = '';
  }

  return renderTemplate(cmd.template, cmd.id, variables);
}

/** Truncate an active-note body to ACTIVE_NOTE_INJECT_MAX_CHARS.
 * Caps at the last newline before the limit so we don't slice
 * mid-paragraph. Returns `truncatedAt: null` when under cap. Pure. */
export function truncateForInject(body: string): {
  body: string;
  truncatedAt: number | null;
} {
  if (body.length <= ACTIVE_NOTE_INJECT_MAX_CHARS) {
    return { body, truncatedAt: null };
  }
  // lastIndexOf returns -1 when no newline exists at or before the
  // index. -1 is truthy in JS, so `|| fallback` does NOT fire —
  // must check >= 0 explicitly. Without this guard, a body with no
  // newlines silently slices to length-1 of the cap.
  const last = body.lastIndexOf('\n', ACTIVE_NOTE_INJECT_MAX_CHARS);
  const cutPoint = last >= 0 ? last : ACTIVE_NOTE_INJECT_MAX_CHARS;
  return {
    body: body.slice(0, cutPoint),
    truncatedAt: cutPoint,
  };
}

function renderTemplate(
  template: string,
  cmdId: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, raw: string) => {
    const [name, fallback] = raw.split('|').map((s) => s.trim());
    if (name in variables) return variables[name];
    if (fallback !== undefined) return fallback;
    console.warn(`skald: slash command '${cmdId}' referenced unknown variable '${name}'`);
    return '';
  });
}

export class SlashCommandModal extends SuggestModal<SlashCommand> {
  constructor(
    app: App,
    private readonly commands: SlashCommand[],
    private readonly onPick: (cmd: SlashCommand) => void,
  ) {
    super(app);
    this.setPlaceholder('Pick a command…');
    this.setInstructions([
      { command: 'Enter', purpose: 'run command' },
      { command: 'Esc', purpose: 'close' },
    ]);
    if (commands.length === 0) {
      new Notice(
        'No commands found. Add notes to your commands folder.',
      );
    }
  }

  override getSuggestions(query: string): SlashCommand[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.commands;
    return this.commands.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }

  override renderSuggestion(cmd: SlashCommand, el: HTMLElement): void {
    el.empty();
    el.addClass('skald-slash-suggest');
    el.createDiv({ cls: 'skald-slash-suggest-name', text: cmd.name });
    if (cmd.description) {
      el.createDiv({
        cls: 'skald-slash-suggest-desc',
        text: cmd.description,
      });
    }
  }

  override onChooseSuggestion(cmd: SlashCommand): void {
    this.onPick(cmd);
  }
}

interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  content: string;
}

/**
 * Lightweight YAML-frontmatter parser — sufficient for skald's
 * command notes which only carry key: value pairs (no nesting, no
 * arrays). Returns the body content with the frontmatter block
 * stripped.
 */
function splitFrontmatter(body: string): ParsedFrontmatter {
  if (!body.startsWith('---\n')) {
    return { frontmatter: {}, content: body };
  }
  const end = body.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, content: body };
  const block = body.slice(4, end);
  const content = body.slice(end + 4).replace(/^\n/, '');
  const fm: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = stripQuotes(m[2].trim());
  }
  return { frontmatter: fm, content };
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const f = s[0];
    if ((f === '"' || f === "'") && s[s.length - 1] === f) {
      return s.slice(1, -1);
    }
  }
  return s;
}
