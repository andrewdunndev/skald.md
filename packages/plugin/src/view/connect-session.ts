/**
 * Transport + ChatSession construction for the chat view.
 *
 * Extracted from view.ts so the main view file stays under the 400-line
 * cap. Contains the connection-mode branching logic: WorkerTransport in
 * 'worker' mode, DirectTransport in 'direct' mode.
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
import { loadSystemPrompt } from './system-prompt';

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

  const handlers: TransportHandlers = {
    onOpen: () => cbs.setStatus('Connected', 'connected'),
    onClose: (code: number, reason: string) =>
      cbs.setStatus(`Disconnected (${code}${reason ? `: ${reason}` : ''})`),
    onMessage: (msg: ServerMessage) => cbs.handleServerMessage(msg),
    onError: (err: string) => cbs.setStatus(`Error: ${err}`, 'error'),
  };

  let transport: ScribianTransport;

  if (mode === 'worker') {
    const { workerUrl, workerToken } = plugin.settings;
    if (!workerUrl || !workerToken) {
      cbs.setStatus('Not configured. Add Worker URL + token in settings.', 'error');
      return null;
    }
    cbs.setStatus('Connecting…');
    transport = new Transport(workerUrl, workerToken, handlers);
  } else {
    transport = new DirectTransport(
      {
        getAnthropicKey: () => plugin.settings.anthropicApiKey,
        getOpenRouterKey: () => plugin.settings.openrouterApiKey,
      },
      handlers,
    );
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
      }),
    (name, input, toolUseId) =>
      executeTool(name, input, toolUseId, {
        app,
        approve: (proposal) =>
          cbs.requestApproval({
            ...proposal,
            informedBy: cbs.currentTurnReads(proposal.toolUseId),
          }),
        memoryClient:
          mode === 'worker'
            ? {
                workerUrl: plugin.settings.workerUrl,
                workerToken: plugin.settings.workerToken,
              }
            : undefined,
        memoryPath: plugin.settings.memoryPath,
        connectionMode: mode,
      }),
    {
      onUpdate: () => cbs.requestRender(),
      onError: (err) => cbs.setStatus(`Chat error: ${err}`, 'error'),
      onDone: (stopReason, usage, provider) =>
        cbs.onDone(stopReason, usage, provider),
    },
  );

  return { transport, session };
}
