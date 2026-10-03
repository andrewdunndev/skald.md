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
 * AND the skald plugin enabled in the open vault. Will refuse
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
 * too long" guard. Wrapping in a void IIFE forces a null return.
 *
 * The outer IIFE is async so a thenable expression (e.g. an inner
 * async IIFE) is awaited before evalVoid resolves. evaluate already
 * passes awaitPromise:true, so the whole pipeline waits for inner
 * async work to settle before the next CDP step runs. */
async function evalVoid(client, expression) {
  // Inner async IIFE so multi-statement expressions (with ;) work
  // AND so any inner thenable is awaited before evalVoid resolves.
  return evaluate(
    client,
    `(async function(){
      await (async () => { ${expression} })();
      return null;
    })()`,
  );
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
       enabled: !!app.plugins.plugins.skald,
       vault: app.vault.getName(),
       leaves: app.workspace.getLeavesOfType('skald-chat').length,
     })`,
  );
  const parsed = JSON.parse(state);
  if (!parsed.enabled) {
    record('plugin-loaded', 'fail', 'skald plugin not enabled');
    return false;
  }
  record('plugin-loaded', 'pass', `vault=${parsed.vault}, leaves=${parsed.leaves}`);
  return true;
}

async function sceneOpenChatPane(client) {
  await evaluate(client, `app.plugins.plugins.skald.activateView()`);
  await delay(600);
  const open = await evaluate(
    client,
    `app.workspace.getLeavesOfType('skald-chat').length > 0`,
  );
  record('open-chat-pane', open ? 'pass' : 'fail', `leaves=${open ? '≥1' : '0'}`);
  const file = await screenshot(client, '01-chat-pane');
  record('open-chat-pane-shot', 'pass', file);
}

async function sceneEmptyState(client) {
  const probe = await evaluate(
    client,
    `(function() {
       const root = document.querySelector('.skald-empty');
       if (!root) return { present: false };
       const chips = Array.from(root.querySelectorAll('.skald-empty-chip'));
       return {
         present: true,
         title: root.querySelector('.skald-empty-title')?.textContent,
         subtitle: root.querySelector('.skald-empty-subtitle')?.textContent,
         chips: chips.map(c => c.querySelector('.skald-empty-chip-label')?.textContent),
       };
     })()`,
  );
  if (!probe.present) {
    record('empty-state', 'fail', 'no .skald-empty in DOM');
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
       const b = document.querySelector('.skald-setup-banner');
       return b ? {
         present: true,
         title: b.querySelector('.skald-setup-banner-title')?.textContent,
         detail: b.querySelector('.skald-setup-banner-detail')?.textContent,
       } : { present: false };
     })()`,
  );
  if (probe.present) {
    record('setup-banner', 'pass', `title="${probe.title}"`);
    await screenshot(client, '03-setup-banner');
  } else {
    // Banner is hidden when the active provider's API key is set —
    // that's the happy path, not a failure.
    record('setup-banner', 'pass', 'not shown (API key already configured)');
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
       const el = document.querySelector('.skald-active-note');
       const label = el?.querySelector('.skald-active-note-label')?.textContent;
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
       const chip = document.querySelector('.skald-empty-chip');
       if (!chip) return null;
       chip.click();
       const input = document.querySelector('.skald-input');
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

async function sceneVaultActionBadge(client) {
  // Inject a finalized assistant turn into the chat session +
  // re-render so the vault-action badge appears. The message has
  // a read tool_use AND a successful write tool_result → badge
  // reads "📖 read 1 · ✏️ wrote …".
  //
  // Start with a new-chat button click so any prior scene's DOM
  // rows + session messages get a clean teardown via the same
  // path the user uses. The button does view.resetChat() which
  // calls session.reset() + messageList.tearDown() + requestRender,
  // and crucially waits one event-loop turn so the throttled
  // requestRender resolves before we inject.
  await evalVoid(
    client,
    `document.querySelector('.skald-header [aria-label="New chat"]')?.click()`,
  );
  await delay(300);
  await evalVoid(
    client,
    `(async function() {
       const leaf = app.workspace.getLeavesOfType('skald-chat')[0];
       const view = leaf.view;
       const session = view.session;
       if (!session) return;
       const messages = session.getMessages();
       messages.push({ role: 'user', content: 'What flower is this and where should I file it?' });
       messages.push({
         role: 'assistant',
         content: [
           { type: 'text', text: "Let me check what's in your flower index." },
           {
             type: 'tool_use', id: 'tu-read-1', name: 'read_note',
             input: { path: 'Garden/Flower Index.md' }
           },
           {
             type: 'tool_result', tool_use_id: 'tu-read-1',
             content: '# Flower Index\\n- Tulip\\n- Daffodil'
           },
           { type: 'text', text: "I'd append a Tulip entry to Garden/Flower Index.md." },
           {
             type: 'tool_use', id: 'tu-write-1', name: 'append_to_note',
             input: { path: 'Garden/Flower Index.md', content: '- Tulip (red, 2026-05-15)' }
           },
           {
             type: 'tool_result', tool_use_id: 'tu-write-1',
             content: 'Appended 28 chars to Garden/Flower Index.md.'
           },
         ],
       });
       await view.messageList.flushRender(messages, null);
     })()`,
  );
  await delay(300);
  const probe = await evaluate(
    client,
    `JSON.stringify({
       badgeText: document.querySelector('.skald-vault-badge-active')?.textContent ?? null,
       badgeIdle: document.querySelector('.skald-vault-badge-idle')?.textContent ?? null,
     })`,
  );
  const parsed = JSON.parse(probe);
  if (!parsed.badgeText || !parsed.badgeText.includes('Garden/Flower Index.md')) {
    record('vault-action-badge', 'fail', `badge missing or wrong path: ${parsed.badgeText}`);
    return;
  }
  record('vault-action-badge', 'pass', `badge: ${parsed.badgeText}`);
  await screenshot(client, '08-vault-action-badge');
}

async function sceneWriteNudge(client) {
  // Inject an assistant turn that SAYS a path but doesn't write to
  // it. Write nudge chips should appear for the unwritten path.
  // Use the new-chat button to fully reset DOM + session before
  // injection — session.reset() alone leaves a throttled-render
  // race that can let the prior scene's rows survive into the
  // next probe.
  await evalVoid(
    client,
    `document.querySelector('.skald-header [aria-label="New chat"]')?.click()`,
  );
  await delay(300);
  await evalVoid(
    client,
    `(async function() {
       const leaf = app.workspace.getLeavesOfType('skald-chat')[0];
       const view = leaf.view;
       const session = view.session;
       if (!session) return;
       const messages = session.getMessages();
       messages.push({ role: 'user', content: 'Plan my trip to Tokyo.' });
       messages.push({
         role: 'assistant',
         content: [
           { type: 'text', text: "Here's a draft. I'd put this in Travel/Tokyo.md or [[Trips Tokyo]] depending on your structure." },
         ],
       });
       await view.messageList.flushRender(messages, null);
     })()`,
  );
  await delay(300);
  const probe = await evaluate(
    client,
    `JSON.stringify({
       nudges: Array.from(document.querySelectorAll('.skald-write-nudge'))
         .map(b => b.textContent.trim()),
       msgCount: app.workspace.getLeavesOfType('skald-chat')[0]?.view?.session?.getMessages?.()?.length,
       lastText: (() => {
         const last = app.workspace.getLeavesOfType('skald-chat')[0]?.view?.session?.getMessages?.()?.slice(-1)[0];
         if (!last) return null;
         if (typeof last.content === 'string') return last.content;
         return last.content.find(b => b.type === 'text')?.text;
       })(),
       renderedTexts: Array.from(document.querySelectorAll('.skald-msg-assistant .skald-text')).map(e => e.textContent.slice(0, 80)),
     })`,
  );
  const parsed = JSON.parse(probe);
  if (!parsed.nudges || parsed.nudges.length === 0) {
    record('write-nudge', 'fail', 'no nudges rendered');
    return;
  }
  const expected = new Set([
    'Propose write to Travel/Tokyo.md',
    'Propose write to Trips Tokyo.md',
  ]);
  const matched = parsed.nudges.filter((n) => expected.has(n));
  if (matched.length !== 2) {
    record('write-nudge', 'warn', `got ${parsed.nudges.length} nudges; expected both .md + wiki: ${parsed.nudges.join(' | ')}`);
  } else {
    record('write-nudge', 'pass', `${parsed.nudges.length} nudges: ${parsed.nudges.join(' | ')}`);
  }
  await screenshot(client, '09-write-nudge');
}

async function sceneIdleBadge(client) {
  // Plain text-only assistant turn → idle badge ("💭 no vault action").
  await evalVoid(
    client,
    `document.querySelector('.skald-header [aria-label="New chat"]')?.click()`,
  );
  await delay(300);
  await evalVoid(
    client,
    `(async function() {
       const leaf = app.workspace.getLeavesOfType('skald-chat')[0];
       const view = leaf.view;
       const session = view.session;
       if (!session) return;
       const messages = session.getMessages();
       messages.push({ role: 'user', content: 'What is 2 + 2?' });
       messages.push({
         role: 'assistant',
         content: [{ type: 'text', text: '4.' }],
       });
       await view.messageList.flushRender(messages, null);
     })()`,
  );
  await delay(300);
  const probe = await evaluate(
    client,
    `JSON.stringify({
       idle: document.querySelector('.skald-vault-badge-idle')?.textContent ?? null,
     })`,
  );
  const parsed = JSON.parse(probe);
  if (!parsed.idle || !parsed.idle.includes('no vault action')) {
    record('idle-badge', 'fail', `idle badge missing: ${parsed.idle}`);
    return;
  }
  record('idle-badge', 'pass', parsed.idle);
  await screenshot(client, '10-idle-badge');
}

async function sceneNewChatReset(client) {
  // Tap the new-chat button + verify the empty state returns.
  await evalVoid(
    client,
    `document.querySelector('.skald-header [aria-label="New chat"]')?.click()`,
  );
  await delay(400);
  const probe = await evaluate(
    client,
    `JSON.stringify({
       hasEmpty: !!document.querySelector('.skald-empty'),
       msgCount: document.querySelectorAll('.skald-msg').length,
     })`,
  );
  const parsed = JSON.parse(probe);
  if (!parsed.hasEmpty || parsed.msgCount > 0) {
    record('new-chat-reset', 'fail', `empty=${parsed.hasEmpty} msgs=${parsed.msgCount}`);
    return;
  }
  record('new-chat-reset', 'pass', 'empty state returned, message list cleared');
  await screenshot(client, '11-after-new-chat');
}

async function sceneSettingsTab(client) {
  // Open the Obsidian settings, switch to the skald tab,
  // capture the skald-specific UI.
  await evalVoid(
    client,
    `app.setting.open(); app.setting.openTabById('skald')`,
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
    `# skald CDP walkthrough — ${new Date().toISOString()}`,
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

console.log(`skald CDP walkthrough — Obsidian @ ${CDP_HTTP}`);
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
  await sceneVaultActionBadge(client);
  await sceneWriteNudge(client);
  await sceneIdleBadge(client);
  await sceneNewChatReset(client);
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
