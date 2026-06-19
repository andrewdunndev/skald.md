/**
 * Token registry + scope enforcement.
 *
 * Two storage modes:
 * - SKALD_TOKENS  JSON array (preferred). Each entry:
 *     { "label": "plugin",      "token": "<hex>", "scopes": ["chat"] }
 *   Tokens are revocable individually (drop one entry, push the secret again).
 *
 * - SKALD_TOKEN   legacy single hex token. Implicitly has all scopes.
 *   Kept for backward compatibility with deployments that pre-date the
 *   multi-token model. New deploys should use SKALD_TOKENS.
 */

export type Scope = 'chat';

export interface TokenRecord {
  label: string;
  token: string;
  scopes: Scope[];
}

export interface AuthResult {
  label: string;
  scopes: Scope[];
}

export class TokenRegistry {
  private records: TokenRecord[] = [];

  constructor(env: { SKALD_TOKENS?: string; SKALD_TOKEN?: string }) {
    if (env.SKALD_TOKENS) {
      try {
        const parsed = JSON.parse(env.SKALD_TOKENS) as unknown;
        if (Array.isArray(parsed)) {
          for (const r of parsed) {
            if (this.isValidRecord(r)) this.records.push(r);
          }
        }
      } catch {
        // Fall through to single-token fallback
      }
    }
    // Legacy fallback: treat the single secret as a "default" record with
    // full capabilities. Always evaluated AFTER explicit records so the
    // explicit registry wins on conflicts.
    if (env.SKALD_TOKEN && !this.records.some((r) => r.token === env.SKALD_TOKEN)) {
      this.records.push({
        label: 'default',
        token: env.SKALD_TOKEN,
        scopes: ['chat'],
      });
    }
  }

  /**
   * Validate a candidate token. Returns the matching record's label + scopes
   * on success, null on no match. Uses constant-time compare against every
   * record so timing leaks the count of records but not which one matched.
   */
  authenticate(candidate: string): AuthResult | null {
    if (!candidate) return null;
    let match: TokenRecord | null = null;
    for (const r of this.records) {
      if (timingSafeEqual(candidate, r.token)) {
        match = r;
        // Don't early-return — keep comparing to flatten timing.
      }
    }
    if (!match) return null;
    return { label: match.label, scopes: match.scopes };
  }

  /**
   * True when the registry has at least one usable record. Used by the
   * Worker to surface a 500 if it's misconfigured.
   */
  hasAny(): boolean {
    return this.records.length > 0;
  }

  /**
   * Non-secret summary of configured tokens for the diagnostic page.
   * Token values intentionally omitted.
   */
  tokenSummaries(): Array<{ label: string; scopes: Scope[] }> {
    return this.records.map((r) => ({ label: r.label, scopes: [...r.scopes] }));
  }

  private isValidRecord(r: unknown): r is TokenRecord {
    if (!r || typeof r !== 'object') return false;
    const rec = r as Record<string, unknown>;
    return (
      typeof rec.label === 'string' &&
      typeof rec.token === 'string' &&
      rec.token.length > 0 &&
      Array.isArray(rec.scopes) &&
      rec.scopes.every(
        (s) => typeof s === 'string' && s === 'chat',
      )
    );
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function hasScope(scopes: Scope[], required: Scope): boolean {
  return scopes.includes(required);
}
