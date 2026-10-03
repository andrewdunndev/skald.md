import { describe, expect, it, vi } from 'vitest';
import { revealChatLeaf } from './reveal-chat-leaf';

function fakeHost(existing: boolean) {
  const order: string[] = [];
  const leaf = { setViewState: vi.fn(async () => { order.push('setViewState'); }) };
  const workspace = {
    getLeavesOfType: vi.fn(() => (existing ? [leaf] : [])),
    getRightLeaf: vi.fn(() => leaf),
    revealLeaf: vi.fn(async () => {
      await Promise.resolve();
      order.push('revealed');
    }),
    setActiveLeaf: vi.fn(() => { order.push('activated'); }),
  };
  return { host: { app: { workspace } }, workspace, leaf, order };
}

describe('revealChatLeaf', () => {
  it('waits for revealLeaf before activating the leaf', async () => {
    const { host, workspace, leaf, order } = fakeHost(true);
    await revealChatLeaf(host.app.workspace as never, 'skald-chat');
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    expect(workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    expect(order).toEqual(['revealed', 'activated']);
  });

  it('creates the right-hand leaf when none exists', async () => {
    const { host, leaf, order } = fakeHost(false);
    await revealChatLeaf(host.app.workspace as never, 'skald-chat');
    expect(leaf.setViewState).toHaveBeenCalled();
    expect(order).toEqual(['setViewState', 'revealed', 'activated']);
  });
});
