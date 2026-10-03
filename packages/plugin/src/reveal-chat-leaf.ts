import type { Workspace } from 'obsidian';

/**
 * Opens (or re-finds) the chat leaf and brings it on screen. revealLeaf is
 * async: on mobile it expands the drawer and switches its active tab, so we
 * wait for it before making the leaf active.
 */
export async function revealChatLeaf(workspace: Workspace, viewType: string): Promise<void> {
  let leaf = workspace.getLeavesOfType(viewType)[0];
  if (!leaf) {
    const right = workspace.getRightLeaf(false);
    if (!right) return;
    leaf = right;
    await leaf.setViewState({ type: viewType, active: true });
  }
  await workspace.revealLeaf(leaf);
  workspace.setActiveLeaf(leaf, { focus: true });
}
