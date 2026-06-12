#!/usr/bin/env node
// DEV ONLY — not part of the plugin build or release assets.
// Evaluate a JS expression in the running Obsidian renderer (CDP :9222).
// Usage: node scripts/cdp-eval.mjs 'app.vault.getName()'
const expr = process.argv[2];
if (!expr) { console.error('usage: cdp-eval.mjs <expression>'); process.exit(2); }

const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no CDP page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const result = await new Promise((resolve, reject) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: expr, awaitPromise: true, returnByValue: true, timeout: 60_000,
  }}));
});
ws.close();
if (result.exceptionDetails) {
  console.error('EXCEPTION:', result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  process.exit(1);
}
console.log(JSON.stringify(result.result.value ?? result.result, null, 2));
