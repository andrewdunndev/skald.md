/**
 * Provider-capability descriptor.
 *
 * Every decision that forks on Provider lives here as a single exhaustive
 * switch. Call sites consume capability fields rather than comparing provider
 * strings directly, so adding a third provider means: extend Provider in
 * @skald/protocol, add a case here, satisfy the compiler — no other
 * file changes required.
 *
 * reasoningModel: the user's configured chat model for the active provider.
 * utilityModel:   cheap model for rerank + future memory upkeep.
 *   Resolution: settings.utilityModel override → provider default.
 *   Set to point the cheap/utility role at any model incl. a local one.
 */

import type { Provider } from '@skald/protocol';
import type { SkaldSettings } from './settings';

/** Exhaustive-switch safety net. TypeScript enforces that every arm of a
 * switch on Provider is handled; the default calls assertNever to get a
 * compile-time error when a new variant is added without updating the
 * switch. At runtime it throws so the missing case is loud. */
function assertNever(x: never): never {
  throw new Error(`Unhandled provider: ${String(x)}`);
}

export interface ProviderCapabilities {
  /** Whether Anthropic prompt-caching breakpoints should be applied. */
  promptCaching: boolean;
  /** Whether extended thinking (budget_tokens) is available. */
  extendedThinking: boolean;
  /** Whether Anthropic native citation content blocks are available. */
  citations: boolean;
}

/** Return the capability descriptor for the given provider. The switch is
 * exhaustive: TypeScript will error if Provider gains a new value and this
 * function is not updated. */
export function providerCapabilities(provider: Provider): ProviderCapabilities {
  switch (provider) {
    case 'anthropic':
      return { promptCaching: true, extendedThinking: true, citations: true };
    case 'openrouter':
      return { promptCaching: false, extendedThinking: false, citations: false };
    default:
      return assertNever(provider);
  }
}

/**
 * The user's configured chat (reasoning) model for the active provider.
 * anthropic → settings.defaultModel
 * openrouter → settings.openrouterModel
 */
export function reasoningModel(settings: SkaldSettings): string {
  switch (settings.provider) {
    case 'anthropic':
      return settings.defaultModel;
    case 'openrouter':
      return settings.openrouterModel;
    default:
      return assertNever(settings.provider);
  }
}

/**
 * Cheap/utility model for rerank and future memory upkeep.
 * Resolution order:
 *   1. settings.utilityModel (when non-empty) — user override, may point
 *      at any model including a local one
 *   2. per-provider default (the cheapest capable Haiku-tier model)
 */
export function utilityModel(settings: SkaldSettings): string {
  if (settings.utilityModel) return settings.utilityModel;
  switch (settings.provider) {
    case 'anthropic':
      return 'claude-haiku-4-5';
    case 'openrouter':
      return 'anthropic/claude-haiku-4-5';
    default:
      return assertNever(settings.provider);
  }
}
