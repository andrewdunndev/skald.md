/**
 * Transport + ChatSession construction for the chat view.
 *
 * Extracted from view.ts so the main view file stays under the 400-line
 * cap. Transport selection is an exhaustive switch on ConnectionMode via
 * modeCapabilities — adding a new mode requires updating mode-capabilities.ts
 * and satisfying the compiler here.
 *
 * Returns the constructed transport and session (or null when configuration
 * is missing in worker mode).
 */
import type { App } from 'obsidian';
import type { Provider, ServerMessage, Usage } from '@scribian/protocol';
import type ScribianPlugin from '../main';
import type { ScribianTransport, TransportHandlers } from '../transport-interface';
import { Transport } from '../transport';
import { DirectTransport } from '../direct-transport';
import { ChatSession } from '../chat-session';
import { buildActiveTools, executeTool } from '../tools';
import type { WriteProposal } from '../tools';
import { modeCapabilities, assertNever } from '../mode-capabilities';
import { loadSystemPrompt } from './system-prompt';
import { providerCapabilities } from '../provider-capabilities';

export interface ConnectResult {
  transport: ScribianTransport;
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
   * composer busy state can be reset in the view layer. */
  onTurnAborted: () => void;
}

/**
 * Build the transport + session for the current connection mode.
 * Returns null if the mode is 'worker' but the URL / token are missing.
 */
export function connectSession(
  app: App,
  plugin: ScribianPlugin,
  cbs: ConnectCallbacks,
): ConnectResult | null {
  const mode = plugin.settings.connectionMode ?? 'direct';

  // session is captured by reference after construction below.
  let sessionRef: ChatSession | null = null;

  const drainIfInFlight = (errorMsg: string): void => {
    if (sessionRef?.isInFlight()) {
      cbs.handleServerMessage({ type: 'error', error: errorMsg });
      cbs.onTurnAborted();
    }
  };

  const handlers: TransportHandlers = {
    onOpen: () => cbs.setStatus('Connected', 'connected'),
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

  const caps = modeCapabilities(mode);
  let transport: ScribianTransport;

  switch (mode) {
    case 'worker': {
      const { workerUrl, workerToken } = plugin.settings;
      if (!workerUrl || !workerToken) {
        cbs.setStatus('Not configured. Add Worker URL + token in settings.', 'error');
        return null;
      }
      cbs.setStatus('Connecting…');
      transport = new Transport(workerUrl, workerToken, handlers);
      break;
    }
    case 'direct':
      transport = new DirectTransport(
        {
          getAnthropicKey: () => plugin.settings.anthropicApiKey,
          getOpenRouterKey: () => plugin.settings.openrouterApiKey,
          getThinkingEnabled: () => plugin.settings.thinkingEnabled,
        },
        handlers,
      );
      break;
    default:
      return assertNever(mode);
  }

  transport.connect();

  const session = new ChatSession(
    transport,
    () => cbs.getModelValue(),
    () => loadSystemPrompt(app, plugin.settings),
    () => {
      const s = plugin.settings;
      const provider = s.provider ?? 'anthropic';
      const apiKey =
        provider === 'openrouter'
          ? s.openrouterApiKey || undefined
          : s.anthropicApiKey || undefined;
      return { provider, apiKey };
    },
    () =>
      buildActiveTools({
        memoryEnabled: plugin.settings.memoryEnabled,
        memoryPath: plugin.settings.memoryPath,
        connectionMode: plugin.settings.connectionMode,
        // Source the live model the same way dispatch does (modelProvider
        // is cbs.getModelValue()) so the two can't diverge mid-session.
        model: cbs.getModelValue(),
      }),
    (name, input, toolUseId) =>
      executeTool(name, input, toolUseId, {
        app,
        approve: (proposal) =>
          cbs.requestApproval({
            ...proposal,
            informedBy: cbs.currentTurnReads(proposal.toolUseId),
          }),
        memoryClient: caps.usesWorker
          ? {
              workerUrl: plugin.settings.workerUrl,
              workerToken: plugin.settings.workerToken,
            }
          : undefined,
        memoryPath: plugin.settings.memoryPath,
        connectionMode: mode,
        anthropicApiKey: plugin.settings.anthropicApiKey || undefined,
        provider: plugin.settings.provider ?? 'anthropic',
      }),
    {
      onUpdate: () => cbs.requestRender(),
      onError: (err) => {
        cbs.setStatus(`Chat error: ${err}`, 'error');
        cbs.onTurnAborted();
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
