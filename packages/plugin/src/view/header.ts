import { setIcon, setTooltip } from 'obsidian';
import { ANTHROPIC_MODELS } from '../settings/provider';
import type { SkaldSettings } from '../settings';

export interface HeaderHooks {
  onModelChange: (newModel: string) => void | Promise<void>;
  onNewChat: () => void;
  /** Called when the user clicks the history button. */
  onHistory?: () => void;
}

export interface HeaderRefs {
  /** The active <select> the host reads via `.value`. For OpenRouter
   * this is a hidden one-option select whose value is the configured
   * model id; for Anthropic it's the visible dropdown. */
  modelSelect: HTMLSelectElement;
}

/**
 * Top-of-pane header: model picker (Anthropic dropdown OR OpenRouter
 * label + hidden select) + new-chat button. Returns the hooks/refs
 * the host needs to keep wired (modelSelect for reading the active
 * model on send).
 */
export function renderHeader(
  parent: HTMLElement,
  settings: SkaldSettings,
  hooks: HeaderHooks,
): HeaderRefs {
  const header = parent.createDiv({ cls: 'skald-header' });
  const provider = settings.provider ?? 'anthropic';

  let modelSelect: HTMLSelectElement;
  if (provider === 'anthropic') {
    // Anthropic-direct: small fixed dropdown of Anthropic models.
    modelSelect = header.createEl('select', {
      cls: 'skald-model',
      attr: { 'aria-label': 'Model' },
    });
    for (const m of ANTHROPIC_MODELS) {
      const opt = modelSelect.createEl('option', {
        text: m.label,
        value: m.id,
      });
      if (m.id === settings.defaultModel) opt.selected = true;
    }
    modelSelect.addEventListener('change', () => {
      void hooks.onModelChange(modelSelect.value);
    });
  } else {
    // OpenRouter / OpenAI-compatible: free-text / catalog model. The
    // chat header shows the active model as a non-editable label;
    // model selection lives in settings. The hidden <select> below is
    // a stand-in so `.value` keeps working — its single option carries
    // the user's configured model for the active provider.
    const isOpenai = provider === 'openai';
    const activeModel = isOpenai ? settings.openaiModel : settings.openrouterModel;
    const fallback = isOpenai ? '' : 'anthropic/claude-sonnet-4-6';
    const label = header.createEl('span', {
      cls: 'skald-model-label',
      text: activeModel || fallback,
    });
    label.setAttr(
      'title',
      isOpenai
        ? 'Active OpenAI-compatible model. Change in settings.'
        : 'Active OpenRouter model. Change in settings.',
    );
    modelSelect = header.createEl('select', {
      cls: 'skald-model skald-model-hidden',
      attr: { 'aria-label': 'Model' },
    });
    const opt = modelSelect.createEl('option', {
      text: activeModel,
      value: activeModel || fallback,
    });
    opt.selected = true;
  }

  if (hooks.onHistory) {
    const historyBtn = header.createEl('button', {
      cls: 'clickable-icon skald-icon-btn',
      attr: { 'aria-label': 'Chat history' },
    });
    setIcon(historyBtn, 'history');
    setTooltip(historyBtn, 'Chat history');
    historyBtn.addEventListener('click', () => hooks.onHistory?.());
  }

  const newChatBtn = header.createEl('button', {
    cls: 'clickable-icon skald-icon-btn',
    attr: { 'aria-label': 'New chat' },
  });
  setIcon(newChatBtn, 'square-pen');
  setTooltip(newChatBtn, 'New chat');
  newChatBtn.addEventListener('click', () => hooks.onNewChat());

  return { modelSelect };
}
