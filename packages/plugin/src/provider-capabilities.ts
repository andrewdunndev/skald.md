/**
 * Provider-capability descriptor.
 *
 * Every decision that forks on Provider lives here as a single exhaustive
 * switch. Call sites consume capability fields rather than comparing provider
 * strings directly, so adding a third provider means: extend Provider in
 * protocol.ts, add a case here, satisfy the compiler — no other
 * file changes required.
 *
 * reasoningModel: the user's configured chat model for the active provider.
 * utilityModel:   cheap per-provider default for rerank and memory upkeep.
 */

import type { Provider } from './protocol';
import type { SkaldSettings } from './settings';

/** Exhaustive-switch safety net. TypeScript enforces that every arm of a
 * switch on Provider is handled; the default calls assertNever to get a
 * compile-time error when a new variant is added without updating the
 * switch. At runtime it throws so the missing case is loud. */
function assertNever(x: never): never {
  throw new Error(`Unhandled provider: ${String(x)}`);
}

/** The set of valid Provider values, kept in lockstep with the Provider
 * union in protocol.ts. This is the single runtime source of truth used
 * to validate the provider field loaded from the (untrusted) data.json. */
const PROVIDERS = ['anthropic', 'openrouter', 'openai'] as const;

/**
 * Runtime type guard for the Provider union. data.json is operator-editable
 * AND delivered by Obsidian Sync, so the persisted `provider` value is
 * untrusted: an unknown string would otherwise flow straight into the
 * exhaustive `switch (provider)` sites below and hit `assertNever`, throwing
 * at runtime (or hanging an init path). loadSettings uses this to coerce any
 * unrecognised value back to the safe default before it reaches those
 * switches.
 */
export function isProvider(value: unknown): value is Provider {
  return (
    typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
  );
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
    case 'openai':
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
    case 'openai':
      return settings.openaiModel || '';
    default:
      return assertNever(settings.provider);
  }
}

/**
 * Cheap/utility model for rerank and memory upkeep: the per-provider default
 * (the cheapest capable Haiku-tier model).
 */
export function utilityModel(settings: SkaldSettings): string {
  switch (settings.provider) {
    case 'anthropic':
      return 'claude-haiku-4-5';
    case 'openrouter':
      return 'anthropic/claude-haiku-4-5';
    case 'openai':
      return settings.openaiModel || '';
    default:
      return assertNever(settings.provider);
  }
}
