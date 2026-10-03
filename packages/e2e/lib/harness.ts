import { browser, $ } from '@wdio/globals';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const SHOTS = path.resolve(import.meta.dirname, '../out/screenshots');

export const NEW_CHAT = '.skald-header [aria-label="New chat"]';
export const FAKE_KEY = 'sk-ant-e2e-fixture';

export async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const tag = (await browser.executeObsidian(({ obsidian }) => (obsidian.Platform.isMobile ? 'mobile' : 'desktop'))) as string;
  await browser.saveScreenshot(path.join(SHOTS, `${tag}-${name}.png`));
}

export async function openChat(): Promise<void> {
  await browser.executeObsidian(async ({ plugins }) => {
    await (plugins.skald as any).activateView();
  });
  await browser.waitUntil(
    async () => (await browser.executeObsidian(({ app }) => app.workspace.getLeavesOfType('skald-chat').length)) > 0,
    { timeoutMsg: 'skald-chat leaf never opened' },
  );
  await $('.skald-input').waitForExist();
}

/** Brings the chat leaf back into view; on mobile, opening a note closes the sidebar drawer that hosts it. */
export async function revealChat(): Promise<void> {
  await browser.executeObsidian(async ({ plugins }) => {
    await (plugins.skald as any).activateView();
  });
  await $('.skald-input').waitForDisplayed({ timeoutMsg: 'chat pane not visible after reveal' });
}

export async function newChat(): Promise<void> {
  await revealChat();
  const btn = await $(NEW_CHAT);
  await btn.waitForClickable();
  await btn.click();
  await $('.skald-empty').waitForExist({ timeoutMsg: 'empty state did not return after New chat' });
}

/** Sets the provider key and routes Anthropic traffic to the mock origin for the rest of the session. */
export async function pointAtMock(origin: string): Promise<void> {
  await browser.executeObsidian(async ({ plugins }, key, base) => {
    const plugin = plugins.skald as any;
    plugin.settings.provider = 'anthropic';
    plugin.settings.anthropicApiKey = key;
    await plugin.saveSettings();
    const original = window.fetch.bind(window);
    const upstream = 'https://api.anthropic.com';
    window.fetch = (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith(upstream) ? original(base + url.slice(upstream.length), init) : original(input, init);
    };
  }, FAKE_KEY, origin);
}

/** Pushes finalized messages into the live chat session and renders them. */
export async function injectTurn(messages: unknown[]): Promise<void> {
  await browser.executeObsidian(async ({ app }, msgs) => {
    const view: any = app.workspace.getLeavesOfType('skald-chat')[0].view;
    const list = view.session.getMessages();
    list.push(...msgs);
    await view.messageList.flushRender(list, null);
  }, messages);
}

export async function sendFromComposer(text: string): Promise<void> {
  const input = await $('.skald-input');
  await input.setValue(text);
  const send = await $('.skald-send');
  await send.waitForClickable();
  await send.click();
}

export async function readVaultFile(p: string): Promise<string> {
  return (await browser.executeObsidian(async ({ app }, file) => app.vault.adapter.read(file), p)) as string;
}
