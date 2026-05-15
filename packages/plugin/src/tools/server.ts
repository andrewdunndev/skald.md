import type { ToolDefinition } from '@scribian/protocol';

/**
 * Anthropic-executed server tools. These are passed in the tools
 * array like custom tools, but Anthropic runs them server-side and
 * emits server_tool_use + web_search_tool_result / web_fetch_tool_result
 * content blocks. The plugin doesn't dispatch them through executeTool.
 *
 * max_uses bounds runaway cost (web_search is ~$0.01/search per
 * Anthropic pricing; 5 caps a turn at ~$0.05).
 */
export const SERVER_TOOLS: ToolDefinition[] = [
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
