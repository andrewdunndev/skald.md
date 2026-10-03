#!/usr/bin/env node
/**
 * Live provider smoke: one tiny streamed request per provider, the same
 * endpoints and headers the plugin's DirectTransport uses. A provider whose
 * key variable is unset is skipped. Keys are read from the environment and
 * never printed; failures report only the HTTP status and the error type.
 *
 *   SKALD_SMOKE_ANTHROPIC_KEY    api.anthropic.com
 *   SKALD_SMOKE_OPENROUTER_KEY   openrouter.ai
 *   SKALD_SMOKE_OPENAI_KEY       OpenAI-compatible endpoint
 *   SKALD_SMOKE_OPENAI_BASE_URL  base URL for the above (required with it)
 *
 * Optional model overrides: SKALD_SMOKE_ANTHROPIC_MODEL,
 * SKALD_SMOKE_OPENROUTER_MODEL, SKALD_SMOKE_OPENAI_MODEL.
 */

const MAX_TOKENS = 20;
const PROMPT = 'Reply with the single word: ok';
const env = (k) => (process.env[k] ?? '').trim();

const PROVIDERS = [
  {
    name: 'anthropic',
    keyVar: 'SKALD_SMOKE_ANTHROPIC_KEY',
    key: env('SKALD_SMOKE_ANTHROPIC_KEY'),
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
    body: () => ({
      model: env('SKALD_SMOKE_ANTHROPIC_MODEL') || 'claude-haiku-4-5',
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    textOf: (d) => (d?.type === 'content_block_delta' ? d.delta?.text ?? '' : ''),
  },
  {
    name: 'openrouter',
    keyVar: 'SKALD_SMOKE_OPENROUTER_KEY',
    key: env('SKALD_SMOKE_OPENROUTER_KEY'),
    url: () => 'https://openrouter.ai/api/v1/messages',
    headers: (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: () => ({
      model: env('SKALD_SMOKE_OPENROUTER_MODEL') || 'anthropic/claude-haiku-4.5',
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    textOf: (d) => (d?.type === 'content_block_delta' ? d.delta?.text ?? '' : ''),
  },
  {
    name: 'openai-compatible',
    keyVar: 'SKALD_SMOKE_OPENAI_KEY',
    key: env('SKALD_SMOKE_OPENAI_KEY'),
    needs: () => (env('SKALD_SMOKE_OPENAI_BASE_URL') ? null : 'SKALD_SMOKE_OPENAI_BASE_URL not set'),
    url: () => `${env('SKALD_SMOKE_OPENAI_BASE_URL').replace(/\/+$/, '')}/chat/completions`,
    headers: (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: () => ({
      model: env('SKALD_SMOKE_OPENAI_MODEL') || 'gpt-4o-mini',
      max_tokens: MAX_TOKENS,
      stream: true,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    textOf: (d) => d?.choices?.[0]?.delta?.content ?? '',
  },
];

async function errorSummary(res) {
  let type = '';
  try {
    const j = await res.json();
    type = String(j?.error?.type ?? j?.error?.code ?? '').slice(0, 60);
  } catch {
    // body was not JSON
  }
  return `HTTP ${res.status}${type ? ` ${type}` : ''}`;
}

async function readStream(res, textOf) {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        text += textOf(JSON.parse(payload));
      } catch {
        // partial or non-JSON frame
      }
    }
  }
  return text;
}

async function run(p) {
  const res = await fetch(p.url(), {
    method: 'POST',
    headers: p.headers(p.key),
    body: JSON.stringify(p.body()),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(await errorSummary(res));
  const text = await readStream(res, p.textOf);
  if (!text) throw new Error('stream ended with no text');
  return text.length;
}

let failed = 0;
for (const p of PROVIDERS) {
  const reason = !p.key ? `${p.keyVar} not set` : p.needs?.();
  if (reason) {
    console.log(`SKIP ${p.name}: ${reason}`);
    continue;
  }
  try {
    const n = await run(p);
    console.log(`OK   ${p.name}: streamed ${n} chars`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${p.name}: ${err.cause?.code ?? err.message}`);
  }
}
process.exit(failed ? 1 : 0);
