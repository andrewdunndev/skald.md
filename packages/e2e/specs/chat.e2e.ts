import { browser, $, $$, expect } from '@wdio/globals';
import {
  MOCK_AFTER_TOOL, MOCK_REPLY, TOOL_CONTENT, TOOL_PATH, TOOL_TRIGGER,
  startMockProvider, type MockProvider,
} from '../lib/mock-provider.js';
import { FAKE_KEY, newChat, openChat, pointAtMock, readVaultFile, sendFromComposer, shot } from '../lib/harness.js';

describe('skald chat against the mock provider', function () {
  let mock: MockProvider;

  before(async function () {
    mock = await startMockProvider();
    await openChat();
    await pointAtMock(mock.origin);
  });

  after(async function () {
    await mock.close();
  });

  beforeEach(async function () {
    await newChat();
    mock.requests.length = 0;
  });

  async function assistantText(): Promise<string> {
    return (await $$('.skald-msg-assistant .skald-text').map((e) => e.getText())).join('\n');
  }

  it('streams a plain reply and sends the configured key', async function () {
    await sendFromComposer('say hello');
    await browser.waitUntil(async () => (await assistantText()).includes(MOCK_REPLY), {
      timeoutMsg: 'mock reply never rendered',
    });
    const req = mock.requests[0];
    expect(req.body.stream).toBe(true);
    expect(req.apiKey).toBe(FAKE_KEY);
    await shot('20-streamed-reply');
  });

  it('tool call surfaces an approval diff card; approve writes the note', async function () {
    const before = await readVaultFile(TOOL_PATH);
    await sendFromComposer(`please ${TOOL_TRIGGER}`);
    const card = await $('.skald-diff');
    await card.waitForExist({ timeoutMsg: 'no approval diff card appeared' });
    await expect($('.skald-diff-path')).toHaveText(TOOL_PATH);
    await expect($('.skald-diff-body')).toHaveText(expect.stringContaining(TOOL_CONTENT));
    await shot('21-approval-card');

    // Nothing is written until the user approves.
    expect(await readVaultFile(TOOL_PATH)).toBe(before);
    await $('.skald-diff-approve').click();

    await browser.waitUntil(async () => (await readVaultFile(TOOL_PATH)).includes(TOOL_CONTENT), {
      timeoutMsg: 'approved append never reached the note',
    });
    await browser.waitUntil(async () => (await assistantText()).includes(MOCK_AFTER_TOOL), {
      timeoutMsg: 'follow-up turn after tool result never rendered',
    });
    const followUp = mock.requests[mock.requests.length - 1].body.messages.at(-1);
    expect(JSON.stringify(followUp.content)).toContain('toolu_mock_1');
  });

  it('rejecting the diff card leaves the note untouched', async function () {
    const before = await readVaultFile(TOOL_PATH);
    await sendFromComposer(`again ${TOOL_TRIGGER}`);
    await $('.skald-diff').waitForExist();
    await $('.skald-diff-reject').click();
    await browser.waitUntil(async () => (await assistantText()).includes(MOCK_AFTER_TOOL), {
      timeoutMsg: 'follow-up turn after rejection never rendered',
    });
    expect(await readVaultFile(TOOL_PATH)).toBe(before);
  });
});
