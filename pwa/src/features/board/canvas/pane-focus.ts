/**
 * Where the keyboard stands on a pane.
 *
 * A control that leaves the board while it holds focus (the bar of a pane
 * shown alone, a placement's target) would drop focus to the page, and the
 * next key would start from nowhere. Its owner hands focus to the pane it was
 * about before it goes: the tile's own tab stop, the button that opens it.
 */

/** Pane ids hold characters a selector would have to escape, so the tile is matched by its data. */
export function paneOpenButton(root: ParentNode | null | undefined, paneId: string): HTMLElement | null {
  if (!root || !paneId) return null;
  for (const tile of root.querySelectorAll<HTMLElement>(".board-pane")) {
    if (tile.dataset.paneId === paneId) return tile.querySelector<HTMLElement>(".board-pane-open");
  }
  return null;
}

/**
 * Give focus to `home` if it is inside `leaving`, which is about to be removed.
 * Focus anywhere else is the reader's own and stays. True when focus moved.
 */
export function handFocusOn(leaving: Element | null | undefined, home: HTMLElement | null | undefined): boolean {
  const active = leaving?.ownerDocument.activeElement;
  if (!leaving || !active || !leaving.contains(active) || !home?.isConnected) return false;
  home.focus({ preventScroll: true });
  return true;
}
