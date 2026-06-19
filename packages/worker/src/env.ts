export interface Env {
  SKALD_TOKEN?: string;
  SKALD_TOKENS?: string;
  /** Anthropic API key (default provider). Optional — Worker is valid
   * with only OPENROUTER_API_KEY set if every user supplies their own
   * Anthropic key in plugin settings. */
  ANTHROPIC_API_KEY?: string;
  /** OpenRouter API key (fallback provider for non-Anthropic models). */
  OPENROUTER_API_KEY?: string;
  SKALD_SESSION: DurableObjectNamespace;
  AI_GATEWAY_URL?: string;
  /** Workers AI binding for vault embeddings (phase 6). Optional —
   * chat path doesn't depend on it; memory feature gates on it. */
  AI?: Ai;
  /** Vectorize index for vault embeddings (phase 6). Optional —
   * memory feature gates on this binding's presence. */
  VECTORIZE?: Vectorize;
}

/** Narrowed env shape required by the vault-memory routes. */
export interface MemoryEnv {
  AI: Ai;
  VECTORIZE: Vectorize;
}
