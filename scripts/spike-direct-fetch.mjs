#!/usr/bin/env node
// DEV ONLY — not part of the plugin build or release assets.
/**
 * SPIKE: direct-mode transport feasibility — can the Obsidian renderer
 * call api.anthropic.com directly with `anthropic-dangerous-direct-
 * browser-access`, no Worker relay?
 *
 * Runs INSIDE the live Obsidian renderer via CDP, so it exercises the
 * real CORS-enforcing environment the plugin ships into (app://obsidian.md
 * origin on desktop Electron; the iOS WKWebView pass repeats this from
 * a dev build on-device).
 *
 * Tests:
 *   A (keyless)  — CORS path probe: a fetch with a dummy key must come
 *                  back as a readable HTTP 401, not a CORS TypeError.
 *   B (keyed)    — real streaming: chunk count + inter-chunk timing must
 *                  show incremental delivery, not one buffered blob.
 *   C (keyed)    — server-side web_search tool on a browser-direct call.
 *
 * Run:
 *   node scripts/spike-direct-fetch.mjs                 # test A only
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/spike-direct-fetch.mjs
 *
 * Requires: Obsidian launched with --remote-debugging-port=9222.
 * Costs (keyed run): two small Haiku calls + one web search (~$0.02).
 */

const CDP_HTTP = 'http://localhost:9222';
const KEY = process.env.ANTHROPIC_API_KEY ?? null;

async function findPage() {
  const targets = await (await fetch(`${CDP_HTTP}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no CDP page target at 9222 — launch Obsidian with --remote-debugging-port=9222');
  return page;
}

function newClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return {
    ready,
    send(method, params = {}) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

// Runs in the renderer. Keep self-contained; serialized via String().
async function rendererSpike(key) {
  const API = 'https://api.anthropic.com/v1/messages';
  const headers = (k) => ({
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-api-key': k,
  });
  const out = { origin: location.origin, ua: navigator.userAgent.slice(0, 80) };

  // A — keyless CORS probe
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: headers('sk-ant-spike-invalid'),
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await r.text();
    out.corsProbe = { ok: true, status: r.status, bodyReadable: body.length > 0, errType: JSON.parse(body)?.error?.type ?? null };
  } catch (e) {
    out.corsProbe = { ok: false, error: String(e) };
    return out; // CORS dead → nothing else can run
  }

  if (!key) { out.keyed = 'skipped — no ANTHROPIC_API_KEY in spike env'; return out; }

  // B — real streaming: prove incremental delivery
  try {
    const t0 = performance.now();
    const r = await fetch(API, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 900, stream: true, messages: [{ role: 'user', content: 'Write a 600-word short story about a lighthouse keeper.' }] }),
    });
    if (!r.ok) { out.stream = { ok: false, status: r.status, body: (await r.text()).slice(0, 200) }; return out; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const arrivals = [];
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Math.round(performance.now() - t0));
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'content_block_delta' && ev.delta?.text) text += ev.delta.text;
        } catch {}
      }
    }
    const spread = arrivals.length > 1 ? arrivals[arrivals.length - 1] - arrivals[0] : 0;
    out.stream = {
      ok: true,
      chunks: arrivals.length,
      firstChunkMs: arrivals[0],
      lastChunkMs: arrivals[arrivals.length - 1],
      spreadMs: spread,
      incremental: arrivals.length >= 5 && spread > 200,
      sampleText: text.slice(0, 40),
    };
  } catch (e) {
    out.stream = { ok: false, error: String(e) };
  }

  // C — server-side web_search on a browser-direct call
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: 'Search the web: what is the current latest stable Obsidian version? One short sentence.' }],
      }),
    });
    const body = await r.json();
    if (!r.ok) { out.webSearch = { ok: false, status: r.status, errType: body?.error?.type, message: body?.error?.message?.slice(0, 200) }; return out; }
    const types = (body.content ?? []).map((b) => b.type);
    out.webSearch = {
      ok: true,
      stopReason: body.stop_reason,
      blockTypes: [...new Set(types)],
      searchRan: types.includes('server_tool_use') || types.includes('web_search_tool_result'),
    };
  } catch (e) {
    out.webSearch = { ok: false, error: String(e) };
  }
  return out;
}

const page = await findPage();
console.log(`page target: ${page.title}`);
const client = newClient(page.webSocketDebuggerUrl);
await client.ready;

const expr = `(${String(rendererSpike)})(${JSON.stringify(KEY)})`;
const result = await client.send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  timeout: 90_000,
});
client.close();

if (result.exceptionDetails) {
  console.error('renderer exception:', JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result.result.value, null, 2));
