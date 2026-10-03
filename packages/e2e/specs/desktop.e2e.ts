import { browser, $, expect } from '@wdio/globals';
import { openChat } from '../lib/harness.js';

describe('skald on the desktop layout', function () {
  it('is not running the mobile layout', async function () {
    await openChat();
    const mobile = await browser.executeObsidian(({ obsidian }) => obsidian.Platform.isMobile);
    expect(mobile).toBe(false);
    await expect($('.skald-input-wrap')).toBeDisplayed();
  });
});
