import { browser, $, expect } from '@wdio/globals';
import { openChat, shot } from '../lib/harness.js';

describe('skald on the emulated 390x844 mobile layout', function () {
  it('runs the mobile layout at the iPhone viewport', async function () {
    await openChat();
    const probe = await browser.executeObsidian(({ obsidian }) => ({
      mobile: obsidian.Platform.isMobile,
      width: window.innerWidth,
    }));
    expect(probe.mobile).toBe(true);
    expect(probe.width).toBeLessThanOrEqual(390);
    await shot('30-mobile-viewport');
  });

  it('keeps the composer inside the viewport with no horizontal overflow', async function () {
    const box = await browser.executeObsidian(() => {
      const wrap = document.querySelector('.skald-input-wrap')!.getBoundingClientRect();
      return { right: wrap.right, left: wrap.left, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.innerW);
    expect(box.scrollW).toBeLessThanOrEqual(box.innerW);
    await expect($('.skald-send')).toBeDisplayed();
  });
});
