import { AbstractInputSuggest, App, requestUrl } from 'obsidian';

/**
 * OpenRouter model catalog autocomplete. Fetches the public
 * `GET https://openrouter.ai/api/v1/models` endpoint (no auth
 * required) on first use, caches the result in plugin data with a
 * 24-hour TTL, fuzzy-matches as the user types.
 *
 * The catalog has hundreds of models with slash-namespaced IDs
 * (`anthropic/claude-opus-4-7`, `openai/gpt-5.2`, etc.). Each
 * suggestion row shows id + friendly name + context window + per-Mtok
 * pricing + capability chips so the user can pick from price/quality
 * trade-offs without leaving Obsidian.
 */

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  promptPricePer1M: number;
  completionPricePer1M: number;
  vision: boolean;
  tools: boolean;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
}

interface OpenRouterCatalogResponse {
  data?: OpenRouterModel[];
}

interface CatalogCache {
  fetchedAt: number;
  models: ModelInfo[];
}

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Process-wide cache so multiple ModelSuggest instances share fetches
// inside one Obsidian session. Replaced on TTL expiry.
let catalogCache: CatalogCache | null = null;
let inFlight: Promise<ModelInfo[]> | null = null;

export class ModelSuggest extends AbstractInputSuggest<ModelInfo> {
  private readonly inputEl: HTMLInputElement;
  private readonly onPick: (model: ModelInfo) => void;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onPick: (model: ModelInfo) => void,
  ) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.onPick = onPick;
  }

  override async getSuggestions(query: string): Promise<ModelInfo[]> {
    const models = await ensureCatalog();
    const q = query.toLowerCase().trim();
    if (!q) {
      // Show a sensible default top-N when the field is empty.
      return models.slice(0, 15);
    }
    return fuzzyRank(models, q).slice(0, 15);
  }

  override renderSuggestion(model: ModelInfo, el: HTMLElement): void {
    el.empty();
    el.style.padding = '0.5rem 0.75rem';
    el.style.borderBottom = '1px solid var(--background-modifier-border)';
    el.style.cursor = 'pointer';
    const id = el.createEl('div', { text: model.id });
    id.style.fontFamily = 'var(--font-monospace, monospace)';
    id.style.fontWeight = '600';
    id.style.fontSize = '0.9rem';

    const meta = el.createEl('div');
    meta.style.fontSize = '0.78rem';
    meta.style.color = 'var(--text-muted)';
    meta.style.marginTop = '0.2rem';
    const parts: string[] = [];
    if (model.name && model.name !== model.id) parts.push(model.name);
    if (model.contextLength)
      parts.push(formatContext(model.contextLength) + ' ctx');
    if (model.promptPricePer1M > 0 || model.completionPricePer1M > 0) {
      parts.push(
        `$${model.promptPricePer1M.toFixed(2)}/$${model.completionPricePer1M.toFixed(2)} per Mtok`,
      );
    }
    const chips: string[] = [];
    if (model.vision) chips.push('👁');
    if (model.tools) chips.push('🛠');
    if (chips.length) parts.push(chips.join(' '));
    meta.setText(parts.join(' · '));
  }

  override selectSuggestion(model: ModelInfo): void {
    this.inputEl.value = model.id;
    this.inputEl.trigger('input');
    this.onPick(model);
    this.close();
  }
}

/**
 * Return the cached catalog or trigger a fresh fetch. Re-uses an
 * in-flight fetch so concurrent suggestion lookups share one request.
 */
async function ensureCatalog(): Promise<ModelInfo[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CACHE_TTL_MS) {
    return catalogCache.models;
  }
  if (inFlight) return inFlight;
  inFlight = fetchCatalog()
    .then((models) => {
      catalogCache = { fetchedAt: Date.now(), models };
      inFlight = null;
      return models;
    })
    .catch((err) => {
      inFlight = null;
      console.warn('skald: ModelSuggest catalog fetch failed', err);
      // Return the stale cache if we have one; otherwise an empty list
      // so the suggestor renders without throwing.
      return catalogCache?.models ?? [];
    });
  return inFlight;
}

async function fetchCatalog(): Promise<ModelInfo[]> {
  // requestUrl (server-side fetch) bypasses the CORS layer that
  // would otherwise block requests from the app://obsidian.md
  // origin. OpenRouter's catalog endpoint may permit CORS today,
  // but the requestUrl path is robust regardless of upstream
  // headers + matches the rest of the plugin's HTTP layer.
  const resp = await requestUrl({
    url: CATALOG_URL,
    method: 'GET',
    headers: { accept: 'application/json' },
    throw: false,
  });
  if (resp.status >= 400) {
    throw new Error(`OpenRouter catalog fetch ${resp.status}`);
  }
  const body = (resp.json ?? {}) as OpenRouterCatalogResponse;
  const raw = body.data ?? [];
  return raw.map(normalize).sort((a, b) => a.id.localeCompare(b.id));
}

function normalize(m: OpenRouterModel): ModelInfo {
  const inputs = m.architecture?.input_modalities ?? [];
  const params = m.supported_parameters ?? [];
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? 0,
    promptPricePer1M: parsePrice(m.pricing?.prompt),
    completionPricePer1M: parsePrice(m.pricing?.completion),
    vision: inputs.includes('image'),
    tools: params.includes('tools') || params.includes('tool_choice'),
  };
}

/**
 * OpenRouter reports prices in dollars per token as strings (e.g.
 * `"0.000003"` = $3 / Mtok). Convert to per-million.
 */
function parsePrice(price: string | undefined): number {
  if (!price) return 0;
  const v = Number(price);
  if (!isFinite(v)) return 0;
  return v * 1_000_000;
}

function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Lightweight fuzzy rank: matches each query word against id + name,
 * scores by position (earlier matches = higher) and consecutive runs.
 * Good enough for ~few-hundred-entry catalog without pulling in a
 * dedicated fuzzy library.
 */
function fuzzyRank(models: ModelInfo[], query: string): ModelInfo[] {
  const words = query.split(/\s+/).filter(Boolean);
  return models
    .map((m) => {
      const hay = `${m.id} ${m.name}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        const idx = hay.indexOf(w);
        if (idx < 0) return null;
        score += 100 - Math.min(99, idx);
      }
      // Bonus for exact prefix matches on the id
      if (m.id.toLowerCase().startsWith(query)) score += 200;
      return { m, score };
    })
    .filter((x): x is { m: ModelInfo; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
}
