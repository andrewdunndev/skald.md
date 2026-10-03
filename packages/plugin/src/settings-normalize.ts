/**
 * data.json trust boundary — normalize/validate persisted settings.
 *
 * Extracted from settings.ts (which holds the SkaldSettings interface,
 * DEFAULT_SETTINGS, and the settings-tab UI) so the normalization logic
 * lives in one focused module and settings.ts stays under the size cap.
 */
import type { SkaldSettings } from './settings';
import { DEFAULT_SETTINGS } from './settings';
import { isProvider } from './provider-capabilities';
import { validateOpenAiBaseUrl } from './openai-base-url';

/**
 * Normalize a settings object loaded from disk into a fully-valid
 * SkaldSettings, treating the input as UNTRUSTED.
 *
 * data.json is operator-editable AND delivered by Obsidian Sync, so the
 * persisted blob is a trust boundary: a hand-edited or sync-corrupted file
 * can carry an unknown `provider` (which would otherwise reach the exhaustive
 * `switch (provider)` sites and throw via assertNever), non-string fields
 * (which would break downstream `.trim()`/string ops), missing keys, or a
 * cleartext non-loopback OpenAI base URL (which would leak prompts + the API
 * key over the wire, bypassing the https-enforcement that only runs on the
 * settings-UI save path).
 *
 * Normalization rules:
 *   - Start from DEFAULT_SETTINGS, then overlay only recognised keys.
 *   - `provider`: coerce any non-Provider value to the default ('anthropic').
 *   - string fields: keep only when the stored value is a string; otherwise
 *     fall back to the default.
 *   - boolean fields: keep only real booleans; otherwise default.
 *   - `webFetchAllowedDomains`: keep only string entries from a stored array.
 *   - `openaiBaseUrl`: run validateOpenAiBaseUrl and CLAMP — if the persisted
 *     URL is insecure (cleartext non-loopback, bad scheme, unparseable),
 *     blank it so the utility/capture paths cannot dispatch over it.
 *
 * Valid settings round-trip unchanged.
 */
export function normalizeSettings(stored: unknown): SkaldSettings {
  const raw: Record<string, unknown> =
    stored !== null && typeof stored === 'object'
      ? (stored as Record<string, unknown>)
      : {};

  const out: SkaldSettings = { ...DEFAULT_SETTINGS };

  // Pull a string field only when the stored value is actually a string;
  // anything else (number, object, null, missing) falls back to the default.
  const str = (key: keyof SkaldSettings): string => {
    const v = raw[key as string];
    return typeof v === 'string' ? v : (DEFAULT_SETTINGS[key] as string);
  };
  // Pull a boolean field only when the stored value is a real boolean.
  const bool = (key: keyof SkaldSettings): boolean => {
    const v = raw[key as string];
    return typeof v === 'boolean' ? v : (DEFAULT_SETTINGS[key] as boolean);
  };

  // provider — coerce unknown values back to the safe default so they can
  // never reach the exhaustive provider switches.
  out.provider = isProvider(raw.provider)
    ? raw.provider
    : DEFAULT_SETTINGS.provider;

  // String-typed settings.
  out.anthropicKeySecret = str('anthropicKeySecret');
  out.openrouterKeySecret = str('openrouterKeySecret');
  out.openaiKeySecret = str('openaiKeySecret');
  out.openaiModel = str('openaiModel');
  out.defaultModel = str('defaultModel');
  out.openrouterModel = str('openrouterModel');
  out.harnessFolder = str('harnessFolder');
  out.savedNotesFolder = str('savedNotesFolder');
  out.chatsFolder = str('chatsFolder');
  out.logsFolder = str('logsFolder');
  out.memoryPath = str('memoryPath');
  out.activePersona = str('activePersona');
  out.commandsFolder = str('commandsFolder');
  out.capturesFolder = str('capturesFolder');
  out.capturePromptPath = str('capturePromptPath');
  out.startersPath = str('startersPath');

  // utilityModel is optional (string | undefined). Keep a stored string,
  // otherwise leave it as the default (empty string).
  out.utilityModel =
    typeof raw.utilityModel === 'string'
      ? raw.utilityModel
      : DEFAULT_SETTINGS.utilityModel;

  // Boolean-typed settings.
  out.memoryEnabled = bool('memoryEnabled');
  out.captureEnabled = bool('captureEnabled');
  out.thinkingEnabled = bool('thinkingEnabled');
  out.compactToolResults = bool('compactToolResults');
  // web_fetch is an exfiltration channel — the gate stays off unless data.json
  // stores a real boolean true; any other value coerces to the safe default.
  out.webToolsEnabled = bool('webToolsEnabled');

  // webFetchAllowedDomains — keep only string entries from a stored array;
  // anything else falls back to the default (empty = no allow-list, i.e. once
  // web tools are explicitly enabled the model may fetch any URL).
  out.webFetchAllowedDomains = Array.isArray(raw.webFetchAllowedDomains)
    ? raw.webFetchAllowedDomains.filter((d): d is string => typeof d === 'string')
    : DEFAULT_SETTINGS.webFetchAllowedDomains;

  // openaiBaseUrl — CLAMP against the https-enforcement rule. A hand-edited
  // cleartext (non-loopback) URL would otherwise be used verbatim by the
  // utility/capture/memory-upkeep paths, leaking prompts + key over the wire.
  // Keep only a string that passes validateOpenAiBaseUrl; blank anything else.
  const candidateBaseUrl =
    typeof raw.openaiBaseUrl === 'string' ? raw.openaiBaseUrl : '';
  out.openaiBaseUrl = validateOpenAiBaseUrl(candidateBaseUrl).ok
    ? candidateBaseUrl
    : '';

  return out;
}
