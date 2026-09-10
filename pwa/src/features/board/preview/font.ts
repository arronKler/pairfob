/**
 * Board preview DOM adapters.
 *
 * The two measurements that must happen on mounted nodes: the glyph pitch of
 * the tile font, and the transform that fits the buffer into the cell. Both are
 * called from the preview component's layout effect, never during render.
 */
import { BOARD_CELL_H, BOARD_CELL_W } from "../../../lib/layout";
import { previewFillScale } from "./model";

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

export function fitPreviewBuffer(host: HTMLElement): void {
  const inner = host.querySelector(".board-pane-buffer");
  if (!(inner instanceof HTMLElement)) return;
  inner.style.transform = "";
  const cw = host.clientWidth;
  const ch = host.clientHeight;
  if (cw <= 0 || ch <= 0) return;
  const sw = inner.offsetWidth || inner.scrollWidth;
  const sh = inner.offsetHeight || inner.scrollHeight;
  const scale = previewFillScale(sw, sh, cw, ch);
  inner.style.transform = `scale(${scale.x}, ${scale.y})`;
  inner.style.transformOrigin = "0 0";
}
