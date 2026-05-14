/**
 * Tool catalog exposed via MCP. Mirrors the read-only tools from
 * packages/plugin/src/tools.ts. Kept here (instead of imported from
 * the plugin) to avoid pulling Obsidian types into the Worker
 * bundle; if these definitions diverge from the plugin side, MCP
 * clients will get a slightly wrong schema but plugin tool execution
 * still works since the plugin re-validates input.
 */
export const MCP_TOOLS = [
  {
    name: 'read_note',
    description:
      'Read the full content of a note in the vault by its vault-relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Vault-relative path, e.g. "folder/note.md"',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_notes',
    description:
      'List notes in the vault, optionally filtered by folder. Returns vault-relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Optional folder path filter' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
    },
  },
  {
    name: 'search_vault',
    description:
      'Substring-search note contents across the vault. Returns matching paths with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text substring to search for' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'current_note',
    description: 'Get the path and full content of the note currently active in Obsidian.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'metadata',
    description:
      'Get frontmatter, tags, headings, and backlinks for a note. Returns JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path' },
      },
      required: ['path'],
    },
  },
];

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function rpcResult(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Standard JSON-RPC error codes
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * Derive a deterministic Durable Object name from the user's bearer
 * token so plugin and MCP client connections collapse to the same DO.
 */
export async function doNameForToken(token: string): Promise<string> {
  const buf = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
