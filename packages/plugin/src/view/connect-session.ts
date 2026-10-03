/**
 * Transport + ChatSession construction for the chat view.
 *
 * Extracted from view.ts so the main view file stays under the 400-line
 * cap. skald is direct-mode only: the plugin always talks to Anthropic /
 * OpenRouter directly via DirectTransport.
 */
import type { App } from 'obsidian';
import type { Provider, ServerMessage, Usage } from '../protocol';
import type SkaldPlugin from '../main';
import type { SkaldTransport, TransportHandlers } from '../transport-interface';
import { DirectTransport } from '../direct-transport';
import { ChatSession } from '../chat-session';
import { buildActiveTools, executeTool } from '../tools';
import type { WriteProposal } from '../tools';
import { loadSystemPrompt } from './system-prompt';
import { bannerInputFor, resolveBannerSpec } from './setup-banner';
import { providerCapabilities } from '../provider-capabilities';
import { compactToolResult } from '../tool-compact';

export interface ConnectResult {
  transport: SkaldTransport;
  session: ChatSession;
}

export interface ConnectCallbacks {
  setStatus: (text: string, modifier?: 'connected' | 'error') => void;
  handleServerMessage: (msg: ServerMessage) => void;
  requestRender: () => void;
  requestApproval: (proposal: WriteProposal & { informedBy?: string[] }) => Promise<boolean>;
  getModelValue: () => string;
  currentTurnReads: (toolUseId: string) => string[];
  onDone: (stopReason: string, usage: Usage, provider?: Provider) => void;
  /** Called when a transport error terminates an in-flight turn so the
   * composer busy state can be reset in the view layer.
   * `retryable` (when true) means the failure was transient and the view
   * should offer a one-tap Resend of the last user turn. */
  onTurnAborted: (retryable?: boolean) => void;
}

/**
 * Build the DirectTransport + ChatSession for the chat view.
 */
export function connectSession(
  app: App,
  plugin: SkaldPlugin,
  cbs: ConnectCallbacks,
): ConnectResult {
  // session is captured by reference after construction below.
  let sessionRef: ChatSession | null = null;

  const drainIfInFlight = (errorMsg: string): void => {
    if (sessionRef?.isInFlight()) {
      cbs.handleServerMessage({ type: 'error', error: errorMsg });
      cbs.onTurnAborted();
    }
  };

  const handlers: TransportHandlers = {
    onOpen: () => {
      // The transport opens synchronously with no handshake, so "open" only
      // means the client is wired up — not that a chat can actually succeed.
      // Gate the positive (green) status on the SAME readiness check the
      // setup banner uses (resolveBannerSpec === null ⇒ the active provider's
      // key/endpoint is present). Otherwise "Connected" would contradict the
      // "add your key" banner sitting right above it.
      const ready = resolveBannerSpec(bannerInputFor(plugin)) === null;
      if (ready) {
        cbs.setStatus('Connected', 'connected');
      } else {
        cbs.setStatus('No API key — add it in Settings → Skald.');
      }
    },
    onClose: (code: number, reason: string) => {
      cbs.setStatus(`Disconnected (${code}${reason ? `: ${reason}` : ''})`);
      drainIfInFlight('Connection lost mid-stream — reconnect and resend.');
    },
    onMessage: (msg: ServerMessage) => cbs.handleServerMessage(msg),
    onError: (err: string) => {
      cbs.setStatus(`Error: ${err}`, 'error');
      drainIfInFlight('Connection error mid-stream — reconnect and resend.');
    },
  };

  const transport: SkaldTransport = new DirectTransport(
    {
      getAnthropicKey: () => plugin.apiKeys().anthropicApiKey,
      getOpenRouterKey: () => plugin.apiKeys().openrouterApiKey,
      getOpenAiKey: () => plugin.apiKeys().openaiApiKey,
      getThinkingEnabled: () => plugin.settings.thinkingEnabled,
    },
    handlers,
  );

  transport.connect();

  const session = new ChatSession(
    transport,
    () => cbs.getModelValue(),
    () => loadSystemPrompt(app, plugin.settings),
    () => {
      const s = plugin.settings;
      const provider = s.provider ?? 'anthropic';
      const baseUrl = provider === 'openai' ? s.openaiBaseUrl || undefined : undefined;
      return { provider, baseUrl };
    },
    () =>
      buildActiveTools({
        memoryEnabled: plugin.settings.memoryEnabled,
        memoryPath: plugin.settings.memoryPath,
        // Source the live model the same way dispatch does (modelProvider
        // is cbs.getModelValue()) so the two can't diverge mid-session.
        model: cbs.getModelValue(),
        // SECURITY: web_fetch is a prompt-injection exfiltration channel
        // (a malicious note can induce a fetch leaking vault contents in
        // the URL). Gate it behind the operator-controlled toggle and the
        // optional domain allow-list. See docs/security-model.md.
        webToolsEnabled: plugin.settings.webToolsEnabled,
        webFetchAllowedDomains: plugin.settings.webFetchAllowedDomains,
      }),
    async (name, input, toolUseId) => {
      const res = await executeTool(name, input, toolUseId, {
        app,
        approve: (proposal) =>
          cbs.requestApproval({
            ...proposal,
            informedBy: cbs.currentTurnReads(proposal.toolUseId),
          }),
        memoryPath: plugin.settings.memoryPath,
        anthropicApiKey: plugin.apiKeys().anthropicApiKey || undefined,
        provider: plugin.settings.provider ?? 'anthropic',
        compactToolResults: plugin.settings.compactToolResults,
      });
      // Apply structural compaction to read-tool results before the
      // message enters the model context.  Write tools are excluded:
      // their result content is a short status string ("Note written"),
      // not a data payload.  Error results are also skipped so the
      // model always sees the full error message.
      //
      // Skip results already marked `compacted` — the three large-output tools
      // (read_note / list_notes / search_vault) compact in-runner, before their
      // internal byte cap.  Compacting again here would be a no-op at best and
      // incorrect at worst (double-densification).
      if (
        plugin.settings.compactToolResults &&
        !res.is_error &&
        !res.compacted &&
        res.content.length > 0
      ) {
        const { text } = compactToolResult(res.content);
        if (text !== res.content) return { ...res, content: text };
      }
      return res;
    },
    {
      onUpdate: () => cbs.requestRender(),
      onError: (err, opts) => {
        cbs.setStatus(`Chat error: ${err}`, 'error');
        cbs.onTurnAborted(opts?.retryable);
      },
      onDone: (stopReason, usage, provider) =>
        cbs.onDone(stopReason, usage, provider),
    },
    // Citations: gate on provider capability so only Anthropic turns inject
    // document blocks. OpenRouter and future providers use the Sources footer.
    () => providerCapabilities(plugin.settings.provider ?? 'anthropic').citations,
  );

  // Capture so drainIfInFlight can inspect session state on close/error.
  sessionRef = session;

  return { transport, session };
}
