import { describe, expect, it, vi } from 'vitest';
import { ApprovalManager } from './approval-manager';
import type { WriteProposal } from './tools';

const baseProposal: WriteProposal = {
  toolUseId: 'tu_abc123',
  kind: 'edit',
  path: 'notes/foo.md',
  before: 'hello',
  after: 'hello world',
};

describe('ApprovalManager', () => {
  it('resolves the request promise with the user decision (approved)', async () => {
    const mgr = new ApprovalManager();
    const promise = mgr.request(baseProposal);
    expect(mgr.has(baseProposal.toolUseId)).toBe(true);
    expect(mgr.size()).toBe(1);

    const handled = mgr.resolve(baseProposal.toolUseId, true);
    expect(handled).toBe(true);
    await expect(promise).resolves.toBe(true);
    expect(mgr.has(baseProposal.toolUseId)).toBe(false);
    expect(mgr.size()).toBe(0);
  });

  it('resolves the request promise with false on reject', async () => {
    const mgr = new ApprovalManager();
    const promise = mgr.request(baseProposal);
    mgr.resolve(baseProposal.toolUseId, false);
    await expect(promise).resolves.toBe(false);
  });

  it('returns false from resolve() for an unknown toolUseId', () => {
    const mgr = new ApprovalManager();
    const handled = mgr.resolve('tu_nonexistent', true);
    expect(handled).toBe(false);
  });

  it('is idempotent — a second resolve() on the same id returns false', () => {
    const mgr = new ApprovalManager();
    mgr.request(baseProposal);
    expect(mgr.resolve(baseProposal.toolUseId, true)).toBe(true);
    expect(mgr.resolve(baseProposal.toolUseId, true)).toBe(false);
  });

  it('fires onPendingChange on every state mutation', () => {
    const onPendingChange = vi.fn();
    const mgr = new ApprovalManager({ onPendingChange });
    mgr.request(baseProposal); // +1
    expect(onPendingChange).toHaveBeenCalledTimes(1);
    mgr.resolve(baseProposal.toolUseId, true); // resolve doesn't fire onPendingChange today
    // abandonAll fires once even if there are zero entries — it's
    // semantically "I'm done"; the renderer can rely on the signal.
    mgr.abandonAll();
    expect(onPendingChange).toHaveBeenCalledTimes(2);
  });

  it('fires onResolve with the proposal and the decision', () => {
    const onResolve = vi.fn();
    const mgr = new ApprovalManager({ onResolve });
    mgr.request(baseProposal);
    mgr.resolve(baseProposal.toolUseId, true);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(baseProposal, true);
  });

  it('does not fire onResolve when resolving an unknown id', () => {
    const onResolve = vi.fn();
    const mgr = new ApprovalManager({ onResolve });
    mgr.resolve('tu_nope', true);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('abandonAll() rejects all pending promises and empties the map', async () => {
    const mgr = new ApprovalManager();
    const p1 = mgr.request({ ...baseProposal, toolUseId: 'tu_1' });
    const p2 = mgr.request({ ...baseProposal, toolUseId: 'tu_2' });
    expect(mgr.size()).toBe(2);
    mgr.abandonAll();
    expect(mgr.size()).toBe(0);
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false);
  });

  it('get() returns the stored entry; has() reflects presence', () => {
    const mgr = new ApprovalManager();
    mgr.request(baseProposal);
    const entry = mgr.get(baseProposal.toolUseId);
    expect(entry?.proposal).toEqual(baseProposal);
    expect(typeof entry?.resolve).toBe('function');
    expect(mgr.has(baseProposal.toolUseId)).toBe(true);
    expect(mgr.has('tu_other')).toBe(false);
  });
});
