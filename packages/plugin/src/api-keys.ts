/**
 * API keys live only in Obsidian secret storage.
 *
 * data.json holds, per provider, the NAME of the secret the user picked in
 * the settings tab (Obsidian's SecretComponent). The key value is read from
 * app.secretStorage each time a request needs it, so it never sits in
 * SkaldSettings and can never reach saveData.
 */
import type { Provider } from '@skald/protocol';

/** The data.json fields that name each provider's secret. */
export interface KeySecretNames {
  anthropicKeySecret: string;
  openrouterKeySecret: string;
  openaiKeySecret: string;
}

/** Key values resolved from secret storage for one request. */
export interface ApiKeys {
  anthropicApiKey: string;
  openrouterApiKey: string;
  openaiApiKey: string;
}

/** The slice of Obsidian's SecretStorage that skald reads. */
export interface SecretReader {
  getSecret(id: string): string | null;
}

function readSecret(store: SecretReader, name: string): string {
  return name ? (store.getSecret(name) ?? '').trim() : '';
}

/** Resolve every provider's key; a missing name or secret resolves to ''. */
export function resolveApiKeys(store: SecretReader, names: KeySecretNames): ApiKeys {
  return {
    anthropicApiKey: readSecret(store, names.anthropicKeySecret),
    openrouterApiKey: readSecret(store, names.openrouterKeySecret),
    openaiApiKey: readSecret(store, names.openaiKeySecret),
  };
}

/** The key for one provider. */
export function keyForProvider(provider: Provider, keys: ApiKeys): string {
  if (provider === 'openrouter') return keys.openrouterApiKey;
  if (provider === 'openai') return keys.openaiApiKey;
  return keys.anthropicApiKey;
}
