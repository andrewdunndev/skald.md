/**
 * Read-only diagnostic page. Shows non-secret state so the operator
 * (you) can sanity-check the deployment from a browser without
 * dropping to wrangler tail. No mutation; token CRUD still goes
 * through `wrangler secret put`.
 *
 * The page exists at /admin and requires a Bearer token with the
 * `chat` scope (the most-privileged scope we have; admin access
 * follows the plugin's permission).
 */

import type { AuditEvent } from './session-state';

export interface AdminViewModel {
  version: number;
  workerName: string;
  anthropicKeyPresent: boolean;
  openrouterKeyPresent: boolean;
  aiGatewayConfigured: boolean;
  tokenSummaries: Array<{ label: string; scopes: string[] }>;
  connectedWebSockets: number;
  recentEvents: AuditEvent[];
}

export function renderAdminPage(vm: AdminViewModel): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>skald Worker · admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --fg: #1a1a1a;
      --muted: #666;
      --border: #ddd;
      --card: #fff;
      --accent: #6d4cef;
      --ok: #2e8b57;
      --warn: #d97706;
      --err: #d33;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111;
        --fg: #ddd;
        --muted: #999;
        --border: #2a2a2a;
        --card: #1a1a1a;
        --accent: #a48cff;
        --ok: #4ade80;
        --warn: #fbbf24;
        --err: #f87171;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.45;
      padding: 1.5rem;
      max-width: 56rem;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 0.25rem 0;
      font-size: 1.75rem;
      font-weight: 600;
    }
    h2 {
      margin: 2rem 0 0.5rem 0;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    p.lead {
      color: var(--muted);
      margin: 0 0 1rem 0;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 0.35rem 0;
      gap: 1rem;
    }
    .row + .row { border-top: 1px dashed var(--border); }
    .row .k { color: var(--muted); }
    .row .v { font-variant-numeric: tabular-nums; }
    .badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 0.78rem;
      color: var(--muted);
      margin-right: 0.25rem;
    }
    .badge.ok { color: var(--ok); border-color: var(--ok); }
    .badge.err { color: var(--err); border-color: var(--err); }
    .badge.warn { color: var(--warn); border-color: var(--warn); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      text-align: left;
      padding: 0.35rem 0.5rem;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 500; font-size: 0.85rem; }
    td.ts { color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    td.type { white-space: nowrap; }
    td.label { color: var(--accent); white-space: nowrap; }
    td.detail { word-break: break-word; }
    pre {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      padding: 0.75rem;
      overflow-x: auto;
      font-size: 0.85rem;
    }
    .muted { color: var(--muted); }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <h1>${vm.workerName} <span class="badge">v${vm.version}</span></h1>
  <p class="lead">Read-only diagnostic page. No mutation — token management runs through <code>wrangler secret put SKALD_TOKENS</code>.</p>

  <h2>Status</h2>
  <div class="card">
    <div class="row">
      <span class="k">Anthropic key</span>
      <span class="v">${
        vm.anthropicKeyPresent
          ? '<span class="badge ok">set on Worker</span>'
          : '<span class="badge warn">plugin-supplied only</span>'
      }</span>
    </div>
    <div class="row">
      <span class="k">OpenRouter key</span>
      <span class="v">${
        vm.openrouterKeyPresent
          ? '<span class="badge ok">set on Worker</span>'
          : '<span class="badge">not configured</span>'
      }</span>
    </div>
    <div class="row">
      <span class="k">AI Gateway</span>
      <span class="v">${
        vm.aiGatewayConfigured
          ? '<span class="badge ok">routing through CF</span>'
          : '<span class="badge">direct to api.anthropic.com</span>'
      }</span>
    </div>
    <div class="row">
      <span class="k">Connected plugins</span>
      <span class="v">${vm.connectedWebSockets}</span>
    </div>
  </div>

  <h2>Tokens</h2>
  <div class="card">
    ${
      vm.tokenSummaries.length === 0
        ? '<p class="muted">No tokens configured.</p>'
        : `<table>
        <thead>
          <tr><th>Label</th><th>Scopes</th></tr>
        </thead>
        <tbody>
        ${vm.tokenSummaries
          .map(
            (t) =>
              `<tr><td>${esc(t.label)}</td><td>${t.scopes
                .map((s) => `<span class="badge">${esc(s)}</span>`)
                .join(' ')}</td></tr>`,
          )
          .join('')}
        </tbody></table>`
    }
    <p class="muted" style="margin-top:1rem;">
      Token values are intentionally hidden. To rotate or add a token:
    </p>
    <pre><code>TOKEN=$(openssl rand -hex 32)
# Edit your SKALD_TOKENS JSON, add/replace an entry, then:
pnpm exec wrangler secret put SKALD_TOKENS</code></pre>
  </div>

  <h2>Recent events (last ${vm.recentEvents.length})</h2>
  <div class="card">
    ${
      vm.recentEvents.length === 0
        ? '<p class="muted">No events yet. Open the chat pane and send a message.</p>'
        : `<table>
        <thead>
          <tr><th>When</th><th>Type</th><th>Provider</th><th>Label</th><th>Detail</th></tr>
        </thead>
        <tbody>
        ${vm.recentEvents
          .slice()
          .reverse()
          .map(
            (e) =>
              `<tr>
                <td class="ts">${esc(formatTs(e.ts))}</td>
                <td class="type">${esc(e.type)}</td>
                <td class="provider">${esc(e.provider ?? '—')}</td>
                <td class="label">${esc(e.label)}</td>
                <td class="detail">${esc(e.detail)}</td>
              </tr>`,
          )
          .join('')}
        </tbody></table>`
    }
    <p class="muted" style="margin-top:1rem;">
      Events ring-buffered (last ${vm.recentEvents.length === 0 ? 'none' : `${vm.recentEvents.length}`}) on the Durable Object and persisted to DO storage, so they survive hibernation. For real-time tail, see <code>wrangler tail</code> or the plugin's logs folder.
    </p>
  </div>

  <h2>Where to go from here</h2>
  <div class="card">
    <ul>
      <li><a href="https://dash.cloudflare.com/" target="_blank">Cloudflare dashboard</a> — full secret + Workers management</li>
      <li><a href="https://dash.cloudflare.com/ai-gateway" target="_blank">AI Gateway dashboard</a> — usage, cache hits, fallback</li>
      <li><code>wrangler tail</code> — live Worker logs</li>
    </ul>
  </div>
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
