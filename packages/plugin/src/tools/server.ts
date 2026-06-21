import type { ToolDefinition } from '@skald/protocol';

/**
 * Anthropic-executed server tools. These are passed in the tools
 * array like custom tools, but Anthropic runs them server-side and
 * emits server_tool_use + web_search_tool_result / web_fetch_tool_result
 * content blocks. The plugin doesn't dispatch them through executeTool.
 *
 * max_uses bounds runaway cost (web_search is ~$0.01/search per
 * Anthropic pricing; 5 caps a turn at ~$0.05).
 *
 * Version pinning is model-specific:
 *   - claude-haiku-4-5 (and any /haiku/ model id) uses the older
 *     20250305 / 20250910 pins. This is a DEFENSIVE PIN: a 400 was
 *     observed in development when the 20260209 versions were sent to
 *     Haiku — Anthropic does not document this difference, so the root
 *     cause is unclear. Do not remove the special-case without first
 *     verifying that a current Haiku model accepts the 20260209 types.
 *   - All other Anthropic models use the current 20260209 pins.
 *
 * OpenRouter translates both pin sets to its own openrouter:web_search /
 * openrouter:web_fetch form unconditionally, so this version choice is
 * purely an Anthropic-API concern — OpenRouter callers need no special
 * handling.
 */

const HAIKU_SERVER_TOOLS: ToolDefinition[] = [
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  },
  {
    type: 'web_fetch_20250910',
    name: 'web_fetch',
    max_uses: 5,
  },
];

const DEFAULT_SERVER_TOOLS: ToolDefinition[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: 5,
  },
  {
    type: 'web_fetch_20260209',
    name: 'web_fetch',
    max_uses: 5,
  },
];

/**
 * Return the correct server-tool declarations for the given model id.
 * Haiku models need the older pin set; everything else gets the current
 * 20260209 pins.
 */
export function serverToolsForModel(model: string): ToolDefinition[] {
  return /haiku/i.test(model) ? HAIKU_SERVER_TOOLS : DEFAULT_SERVER_TOOLS;
}

/**
 * Default server tools (20260209 pins). Re-exported for callers that
 * need a static representative set (tests, ALL_TOOLS aggregate).
 * Live sessions must use serverToolsForModel(model) instead.
 */
export const SERVER_TOOLS: ToolDefinition[] = DEFAULT_SERVER_TOOLS;
