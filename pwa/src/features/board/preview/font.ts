/**
 * Board preview DOM adapters.
 *
 * The two measurements that must happen on mounted nodes: the glyph pitch of
 * the tile font, and the scale that fits the buffer into the cell. Both are
 * called from the preview component's layout effect, never during render.
 */
import { BOARD_CELL_H, BOARD_CELL_W } from "../../../lib/layout";
import { previewFit } from "./model";

/** Size the tile font so one glyph advance is exactly one board cell. */
export function applyBoardPreviewFont(host: HTMLElement): void {
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  probe.style.fontFamily = globalThis.getComputedStyle?.(host).fontFamily || "monospace";
  probe.style.fontSize = "100px";
  probe.style.lineHeight = "1";
  probe.style.whiteSpace = "pre";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  host.append(probe);
  const ch = probe.offsetWidth / 10;
  probe.remove();
  if (ch > 0) host.style.fontSize = `${100 * (BOARD_CELL_W / ch)}px`;
  host.style.lineHeight = `${BOARD_CELL_H}px`;
}

/** What `fitPreviewBuffer` tells the styles. */
const FIT_PROPERTIES = [
  "--board-preview-fit-width",
  "--board-preview-fit-height",
  "--board-preview-width",
  "--board-preview-height",
] as const;

/**
 * How the buffer fills its pane, as numbers the styles turn into the transform
 * (`.board-pane-buffer`): the scale that fits the grid into the whole cell by
 * its width and by its height, and the cell's size in stage pixels. The styles
 * take the room the pane's ring and title bar need off those, and that room
 * follows the camera, so nothing is measured again when the board is zoomed.
 */
export function fitPreviewBuffer(host: HTMLElement): void {
  const inner = host.querySelector(".board-pane-buffer");
  if (!(inner instanceof HTMLElement)) return;
  for (const property of FIT_PROPERTIES) inner.style.removeProperty(property);
  const cw = host.clientWidth;
  const ch = host.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const sw = inner.offsetWidth || inner.scrollWidth;
  const sh = inner.offsetHeight || inner.scrollHeight;
  const fit = previewFit(sw, sh, cw, ch);
  const values = [fit.byWidth, fit.byHeight, cw, ch];
  FIT_PROPERTIES.forEach((property, index) => inner.style.setProperty(property, String(values[index])));
}
