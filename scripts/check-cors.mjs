#!/usr/bin/env node
/**
 * CORS preflight probe for the three origins a skald request can leave from:
 *   capacitor://localhost  Obsidian iOS (WKWebView)
 *   http://localhost       Obsidian Android (Capacitor)
 *   app://obsidian.md      Obsidian desktop (Electron)
 *
 * Sends one OPTIONS preflight per (endpoint, origin) carrying the exact
 * request headers DirectTransport sets, then reports what the server
 * answers in access-control-allow-origin / -headers. No credentials are
 * sent and no tokens are spent: a preflight never reaches the model.
 *
 *   node scripts/check-cors.mjs [--openai-base https://host/v1] [--strict] [--json]
 *
 * The OpenAI-compatible base URL also comes from SKALD_CORS_OPENAI_BASE_URL.
 * --strict exits 1 when a probed endpoint blocks any origin; without it the
 * script only reports. Exit 2 means the probe itself could not complete.
 */

const ORIGINS = ['capacitor://localhost', 'http://localhost', 'app://obsidian.md'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const strict = process.argv.includes('--strict');
const asJson = process.argv.includes('--json');
const openaiBase = (arg('--openai-base') ?? process.env.SKALD_CORS_OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

const ENDPOINTS = [
  {
    name: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    headers: ['content-type', 'x-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access'],
  },
  {
    name: 'openrouter /messages',
    url: 'https://openrouter.ai/api/v1/messages',
    headers: ['authorization', 'content-type', 'http-referer', 'x-openrouter-title'],
  },
  {
    name: 'openrouter /chat/completions',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: ['authorization', 'content-type'],
  },
  {
    name: 'openai-compatible',
    url: `${openaiBase}/chat/completions`,
    headers: ['authorization', 'content-type'],
  },
];

function allows(list, wanted) {
  if (!list) return [];
  const have = list.split(',').map((s) => s.trim().toLowerCase());
  if (have.includes('*')) return [];
  return wanted.filter((h) => !have.includes(h));
}

async function probe(endpoint, origin) {
  const res = await fetch(endpoint.url, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': endpoint.headers.join(','),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const acao = res.headers.get('access-control-allow-origin');
  const ach = res.headers.get('access-control-allow-headers');
  const originOk = acao === '*' || acao === origin;
  const missing = allows(ach, endpoint.headers);
  return { endpoint: endpoint.name, origin, status: res.status, acao, ach, ok: originOk && missing.length === 0 && res.status < 400, missing };
}

const rows = [];
let failedProbe = false;
for (const endpoint of ENDPOINTS) {
  for (const origin of ORIGINS) {
    try {
      rows.push(await probe(endpoint, origin));
    } catch (err) {
      failedProbe = true;
      rows.push({ endpoint: endpoint.name, origin, status: 'ERR', acao: null, ach: null, ok: false, missing: [], error: err.cause?.code ?? err.name });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('| endpoint | origin | status | allow-origin | allow-headers | verdict |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    const verdict = r.error ? `error ${r.error}` : r.ok ? 'allowed' : r.acao ? `blocked (missing: ${r.missing.join(' ') || 'origin'})` : 'blocked (no CORS headers)';
    const ach = r.ach && r.ach.length > 36 ? `${r.ach.split(',').length} headers` : (r.ach ?? '-');
    console.log(`| ${r.endpoint} | ${r.origin} | ${r.status} | ${r.acao ?? '-'} | ${ach} | ${verdict} |`);
  }
}

if (failedProbe) process.exit(2);
if (strict && rows.some((r) => !r.ok)) process.exit(1);
