#!/usr/bin/env node
/**
 * Live UI walkthrough via Chrome DevTools Protocol against a running
 * Obsidian instance with `--remote-debugging-port=9222`. Walks the
 * plugin's visible surfaces, screenshots each scene, asserts DOM
 * state per scene, and writes a markdown report at the end.
 *
 * Used as the "I exercised every UI state on desktop" half of the
 * pre-tag verification pass — catches DOM/CSS issues that unit
 * tests structurally can't see, before the user reaches for the
 * iPad.
 *
 * Run:
 *   pnpm check:cdp
 *
 * Output:
 *   scripts/cdp-out/screenshots/<scene>.png
 *   scripts/cdp-out/report.md
 *
 * Requires: Obsidian launched with --remote-debugging-port=9222
 * AND the scribian plugin enabled in the open vault. Will refuse
 * to run otherwise.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const OUT_DIR = path.join(ROOT, 'scripts/cdp-out');
const SHOTS = path.join(OUT_DIR, 'screenshots');

await fs.mkdir(SHOTS, { recursive: true });

const CDP_HTTP = 'http://localhost:9222';

const findings = []; // { scene, status: 'pass'|'warn'|'fail', detail }
function record(scene, status, detail) {
  findings.push({ scene, status, detail });
  const tag = status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗';
  console.log(`  ${tag} ${scene}: ${detail}`);
}

async function findPage() {
  const targets = await (await fetch(`${CDP_HTTP}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no CDP page target found at 9222');
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
      if (msg.error) reject(new Error(`${msg.error.message}: ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    }
  };
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  const ready = new Promise((r) => {
    ws.onopen = r;
  });
  return {
    ready,
    send,
    close: () => ws.close(),
  };
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  }
  return r.result?.value;
}

/** Run an expression for its side effect and discard the result.
 * Some Obsidian APIs (app.setting.open(), modal closers) return
 * objects whose JSON serialization trips CDP's "reference chain
 * too long" guard. Wrapping in a void IIFE forces a null return. */
async function evalVoid(client, expression) {
  return evaluate(client, `(function(){ ${expression}; return null; })()`);
}

async function screenshot(client, name) {
  const r = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, `${name}.png`);
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  return path.relative(ROOT, file);
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Scenes ────────────────────────────────────────────────────────

async function scenePluginLoaded(client) {
  const state = await evaluate(
    client,
    `JSON.stringify({
       enabled: !!app.plugins.plugins.scribian,
       vault: app.vault.getName(),
       leaves: app.workspace.getLeavesOfType('scribian-chat').length,
     })`,
  );
  const parsed = JSON.parse(state);
  if (!parsed.enabled) {
    record('plugin-loaded', 'fail', 'scribian plugin not enabled');
    return false;
  }
  record('plugin-loaded', 'pass', `vault=${parsed.vault}, leaves=${parsed.leaves}`);
  return true;
}

async function sceneOpenChatPane(client) {
  await evaluate(client, `app.plugins.plugins.scribian.activateView()`);
  await delay(600);
  const open = await evaluate(
    client,
    `app.workspace.getLeavesOfType('scribian-chat').length > 0`,
  );
  record('open-chat-pane', open ? 'pass' : 'fail', `leaves=${open ? '≥1' : '0'}`);
  const file = await screenshot(client, '01-chat-pane');
  record('open-chat-pane-shot', 'pass', file);
}

async function sceneEmptyState(client) {
  const probe = await evaluate(
    client,
    `(function() {
       const root = document.querySelector('.scribian-empty');
       if (!root) return { present: false };
       const chips = Array.from(root.querySelectorAll('.scribian-empty-chip'));
       return {
         present: true,
         title: root.querySelector('.scribian-empty-title')?.textContent,
         subtitle: root.querySelector('.scribian-empty-subtitle')?.textContent,
         chips: chips.map(c => c.querySelector('.scribian-empty-chip-label')?.textContent),
       };
     })()`,
  );
  if (!probe.present) {
    record('empty-state', 'fail', 'no .scribian-empty in DOM');
    return;
  }
  if (!probe.chips || probe.chips.length === 0) {
    record('empty-state', 'warn', 'rendered but no chips');
    return;
  }
  record(
    'empty-state',
    'pass',
    `title="${probe.title}" chips=${probe.chips.length}: ${probe.chips.join(', ')}`,
  );
  await screenshot(client, '02-empty-state');
}

async function sceneSetupBanner(client) {
  const probe = await evaluate(
    client,
    `(function() {
       const b = document.querySelector('.scribian-setup-banner');
       return b ? {
         present: true,
         title: b.querySelector('.scribian-setup-banner-title')?.textContent,
         detail: b.querySelector('.scribian-setup-banner-detail')?.textContent,
       } : { present: false };
     })()`,
  );
  if (probe.present) {
    record('setup-banner', 'pass', `title="${probe.title}"`);
    await screenshot(client, '03-setup-banner');
  } else {
    // Banner is hidden when both workerUrl + workerToken are
    // configured — that's the happy path, not a failure.
    record('setup-banner', 'pass', 'not shown (worker already configured)');
  }
}

async function sceneActiveNote(client) {
  // Open the first markdown file in the vault to exercise the
  // active-note indicator.
  const opened = await evaluate(
    client,
    `(async function() {
       const md = app.vault.getMarkdownFiles()[0];
       if (!md) return null;
       const leaf = app.workspace.getLeaf();
       await leaf.openFile(md);
       return md.path;
     })()`,
  );
  if (!opened) {
    record('active-note', 'warn', 'no markdown files in vault');
    return;
  }
  await delay(300);
  const probe = await evaluate(
    client,
    `(function() {
       const el = document.querySelector('.scribian-active-note');
       const label = el?.querySelector('.scribian-active-note-label')?.textContent;
       return { present: !!el, label, displayed: el ? el.style.display !== 'none' : false };
     })()`,
  );
  if (!probe.present || !probe.displayed) {
    record('active-note', 'fail', 'indicator not rendered/visible');
    return;
  }
  record('active-note', 'pass', `label="${probe.label}" (opened ${opened})`);
  await screenshot(client, '04-active-note');
}

async function sceneStarterPick(client) {
  // Tap the first starter chip and verify it fills the composer.
  const filled = await evaluate(
    client,
    `(function() {
       const chip = document.querySelector('.scribian-empty-chip');
       if (!chip) return null;
       chip.click();
       const input = document.querySelector('.scribian-input');
       return input ? input.value.slice(0, 60) : null;
     })()`,
  );
  if (!filled) {
    record('starter-pick', 'fail', 'chip or input missing');
    return;
  }
  record('starter-pick', 'pass', `input now: "${filled}…"`);
  await screenshot(client, '05-starter-filled');
}

async function sceneSetupURI(client) {
  // Trigger the scribian-setup protocol handler directly with a
  // fake endpoint + token, verify the confirmation modal renders
  // with masked token preview.
  await evaluate(
    client,
    `(function() {
       const data = {
         action: 'scribian-setup',
         endpoint: 'https://test.example.workers.dev',
         token: 'abcd1234efgh5678ijkl9012'
       };
       app.plugins.plugins.scribian.handleSetupUri(data);
     })()`,
  );
  await delay(400);
  const probe = await evaluate(
    client,
    `(function() {
       const modal = document.querySelector('.scribian-setup-confirm');
       if (!modal) return { present: false };
       const fields = Array.from(modal.querySelectorAll('.scribian-confirm-field-value'))
         .map(e => e.textContent);
       return { present: true, fields };
     })()`,
  );
  if (!probe.present) {
    record('setup-uri-modal', 'fail', 'confirmation modal did not render');
    return;
  }
  const tokenField = probe.fields[1] ?? '';
  const masked = tokenField.includes('…') && !tokenField.includes('efgh5678');
  record(
    'setup-uri-modal',
    masked ? 'pass' : 'warn',
    masked
      ? `fields=${probe.fields.join(' | ')}`
      : `token shown unmasked: "${tokenField}"`,
  );
  await screenshot(client, '06-setup-confirm-modal');
  // Close the modal so the next scenes have a clean DOM
  await evalVoid(
    client,
    `document.querySelector('.scribian-setup-confirm')
       ?.closest('.modal-container')?.querySelector('.modal-close-button')?.click()`,
  );
  await delay(200);
}

async function sceneSettingsTab(client) {
  // Open the Obsidian settings, switch to the scribian tab,
  // capture the scribian-specific UI.
  await evalVoid(
    client,
    `app.setting.open(); app.setting.openTabById('scribian')`,
  );
  await delay(500);
  // JSON.stringify the result inside the page so CDP returns a
  // string — avoids the "Object reference chain is too long" error
  // when probing inside a modal whose DOM has rich object refs.
  const raw = await evaluate(
    client,
    `JSON.stringify({
       headings: Array.from(document.querySelectorAll('.modal .setting-item-heading'))
         .map(h => (h.querySelector('.setting-item-name')?.textContent || h.textContent || '').trim())
         .filter(s => s),
     })`,
  );
  const probe = JSON.parse(raw);
  if (!probe.headings || probe.headings.length < 3) {
    record('settings-tab', 'warn', `only ${probe.headings?.length ?? 0} headings`);
  } else {
    record('settings-tab', 'pass', `headings: ${probe.headings.slice(0, 6).join(' / ')}`);
  }
  await screenshot(client, '07-settings');
  await evalVoid(client, `app.setting.close()`);
  await delay(200);
}

// ─── Driver ───────────────────────────────────────────────────────

async function writeReport() {
  const lines = [
    `# scribian CDP walkthrough — ${new Date().toISOString()}`,
    '',
    'Live UI walkthrough against Obsidian running with',
    '`--remote-debugging-port=9222`. Each scene exercises one visible',
    'surface; screenshots in `screenshots/`.',
    '',
    '| Scene | Status | Detail |',
    '|---|---|---|',
    ...findings.map(
      (f) =>
        `| \`${f.scene}\` | ${f.status === 'pass' ? '✓' : f.status === 'warn' ? '!' : '✗'} | ${f.detail.replace(/\|/g, '\\|')} |`,
    ),
  ];
  const pass = findings.filter((f) => f.status === 'pass').length;
  const warn = findings.filter((f) => f.status === 'warn').length;
  const fail = findings.filter((f) => f.status === 'fail').length;
  lines.push(
    '',
    `**Summary:** ${pass} pass, ${warn} warn, ${fail} fail.`,
    '',
  );
  await fs.writeFile(path.join(OUT_DIR, 'report.md'), lines.join('\n'));
}

console.log(`scribian CDP walkthrough — Obsidian @ ${CDP_HTTP}`);
const target = await findPage();
console.log(`target: ${target.title}`);
const client = newClient(target.webSocketDebuggerUrl);
await client.ready;

try {
  await client.send('Runtime.enable', {});
  await client.send('Page.enable', {});

  if (!(await scenePluginLoaded(client))) {
    console.log('\nFAIL: plugin not enabled — bail.');
    process.exit(1);
  }
  await sceneOpenChatPane(client);
  await sceneEmptyState(client);
  await sceneSetupBanner(client);
  await sceneActiveNote(client);
  await sceneStarterPick(client);
  await sceneSetupURI(client);
  await sceneSettingsTab(client);
} finally {
  client.close();
}

await writeReport();

const fail = findings.filter((f) => f.status === 'fail').length;
console.log(
  `\n${fail === 0 ? 'OK' : 'FAIL'}: ${findings.length} scenes, ${fail} failure(s). Report: scripts/cdp-out/report.md`,
);
process.exit(fail === 0 ? 0 : 1);
