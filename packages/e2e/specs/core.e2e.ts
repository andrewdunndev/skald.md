import { browser, $, $$, expect } from '@wdio/globals';
import { injectTurn, newChat, openChat, shot } from '../lib/harness.js';

describe('skald core scenes', function () {
  it('plugin-loaded: skald is enabled in the fixture vault', async function () {
    const state = await browser.executeObsidian(({ app, plugins }) => ({
      enabled: !!plugins.skald,
      vault: app.vault.getName(),
    }));
    expect(state.enabled).toBe(true);
  });

  it('open-chat-pane: activateView opens a skald-chat leaf', async function () {
    await openChat();
    await shot('01-chat-pane');
  });

  it('empty-state: title and starter chips render', async function () {
    await $('.skald-empty').waitForExist();
    await expect($('.skald-empty-title')).toHaveText(expect.stringMatching(/\S/));
    expect((await $$('.skald-empty-chip')).length).toBeGreaterThan(0);
    await shot('02-empty-state');
  });

  it('setup-banner: shown while the active provider has no key', async function () {
    await expect($('.skald-setup-banner')).toExist();
    await expect($('.skald-setup-banner-title')).toHaveText(expect.stringMatching(/\S/));
    await shot('03-setup-banner');
  });

  it('active-note: opening a note shows the active-note indicator', async function () {
    const opened = await browser.executeObsidian(async ({ app }) => {
      const md = app.vault.getMarkdownFiles()[0];
      await app.workspace.getLeaf().openFile(md);
      return md.path;
    });
    expect(opened).toMatch(/\.md$/);
    const el = await $('.skald-active-note');
    await el.waitForDisplayed();
    await expect($('.skald-active-note-label')).toHaveText(expect.stringMatching(/\S/));
    await shot('04-active-note');
  });

  it('starter-pick: tapping a starter chip fills the composer', async function () {
    await $('.skald-empty-chip').click();
    await browser.waitUntil(async () => (await $('.skald-input').getValue()).length > 0, {
      timeoutMsg: 'composer stayed empty after chip tap',
    });
    await shot('05-starter-filled');
  });

  it('vault-action-badge: a read plus a write shows the written path', async function () {
    await newChat();
    await injectTurn([
      { role: 'user', content: 'What flower is this and where should I file it?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "Let me check what's in your flower index." },
          { type: 'tool_use', id: 'tu-read-1', name: 'read_note', input: { path: 'Garden/Flower Index.md' } },
          { type: 'tool_result', tool_use_id: 'tu-read-1', content: '# Flower Index\n- Tulip\n- Daffodil' },
          { type: 'text', text: "I'd append a Tulip entry to Garden/Flower Index.md." },
          { type: 'tool_use', id: 'tu-write-1', name: 'append_to_note', input: { path: 'Garden/Flower Index.md', content: '- Tulip (red)' } },
          { type: 'tool_result', tool_use_id: 'tu-write-1', content: 'Appended 13 chars to Garden/Flower Index.md.' },
        ],
      },
    ]);
    const badge = await $('.skald-vault-badge-active');
    await badge.waitForExist();
    await expect(badge).toHaveText(expect.stringContaining('Garden/Flower Index.md'));
    await shot('08-vault-action-badge');
  });

  it('write-nudge: an unwritten path offers a propose-write chip for each form', async function () {
    await newChat();
    await injectTurn([
      { role: 'user', content: 'Plan my trip to Tokyo.' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: "Here's a draft. I'd put this in Travel/Tokyo.md or [[Trips Tokyo]] depending on your structure." }],
      },
    ]);
    await $('.skald-write-nudge').waitForExist();
    const labels = (await $$('.skald-write-nudge').map((n) => n.getText())).map((t) => t.trim());
    expect(labels).toEqual(expect.arrayContaining(['Propose write to Travel/Tokyo.md', 'Propose write to Trips Tokyo.md']));
    await shot('09-write-nudge');
  });

  it('idle-badge: a text-only turn reads as no vault action', async function () {
    await newChat();
    await injectTurn([
      { role: 'user', content: 'What is 2 + 2?' },
      { role: 'assistant', content: [{ type: 'text', text: '4.' }] },
    ]);
    const idle = await $('.skald-vault-badge-idle');
    await idle.waitForExist();
    await expect(idle).toHaveText(expect.stringContaining('no vault action'));
    await shot('10-idle-badge');
  });

  it('new-chat-reset: New chat clears messages and restores the empty state', async function () {
    await newChat();
    expect((await $$('.skald-msg')).length).toBe(0);
    await shot('11-after-new-chat');
  });

  it('settings-tab: the skald tab lists at least three headings', async function () {
    await browser.executeObsidian(({ app }) => {
      const setting = (app as any).setting;
      setting.open();
      setting.openTabById('skald');
    });
    await $('.modal .setting-item-heading').waitForExist();
    const headings = await $$('.modal .setting-item-heading').map((h) => h.getText());
    expect(headings.filter((t) => t.trim()).length).toBeGreaterThanOrEqual(3);
    await shot('07-settings');
    await browser.executeObsidian(({ app }) => {
      (app as any).setting.close();
    });
  });
});
