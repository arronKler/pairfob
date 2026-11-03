import { composeMinPx } from "../compose-size";
import { terminalViewportSize, usedWidth, type HostInner } from "./full-terminal-fit";

/**
 * The room the computer's terminal is sized against.
 *
 * Usually that is the box the renderer shows. Two things take part of that
 * box without being a reason to resize the computer's terminal: beside the
 * list, the inspector, which covers some of the column's width for as long as
 * it is open; and everywhere, a draft longer than one line, which takes a row
 * for every line until it is sent. Both are measured back in here, so the
 * request is what it would be without them and only the window resizing (or a
 * keyboard on the glass) changes it. The floating key panel takes no layout
 * height at all; it covers the host and the cursor's row is lifted past it
 * (see `floatingPadCover` and the fit controller).
 */
export function terminalRoom(host: HTMLElement, visible: HostInner): HostInner {
  return {
    width: visible.width + coveredWidth(host),
    height: visible.height + coveredHeight(host),
  };
}

/** The room's height as the page stands, between fits. */
export function terminalRoomHeight(host: HTMLElement): number {
  return terminalRoom(host, terminalViewportSize(host)).height;
}

/**
 * The shell lays its columns out as list, session, inspector (`app/layout`).
 * Closing the inspector hands its column to the session, and brings the list
 * back if the list had given way to make room.
 */
function coveredWidth(host: HTMLElement): number {
  const app = host.closest<HTMLElement>("#app.desk.inspector");
  if (!app) return 0;
  const inspector = Array.from(app.children).find((child) => child.classList.contains("inspector"));
  if (!(inspector instanceof HTMLElement)) return 0;
  const list = app.classList.contains("rail-hidden") ? hiddenListWidth(host) : 0;
  return Math.max(0, usedWidth(inspector) - list);
}

/** A hidden list has no box to measure; its column width is the shell's `--rail-w`. */
function hiddenListWidth(host: HTMLElement): number {
  const probe = host.ownerDocument.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(--rail-w,0px)";
  host.append(probe);
  const width = usedWidth(probe);
  probe.remove();
  return width;
}

/**
 * How much shorter the pad's passing parts made the terminal: the lines a draft
 * has grown past its first. The key panel floats over the host instead, so it
 * costs the computer's terminal nothing.
 */
function coveredHeight(host: HTMLElement): number {
  const pad = host.parentElement?.querySelector<HTMLElement>(".full-terminal-pad");
  return pad ? draftGrowth(pad) : 0;
}

/**
 * How much of the host's bottom the floating key panel covers. The panel hangs
 * above the dock, so its top marks the point where terminal output is no
 * longer visible; the fit controller lifts the cursor's row clear of it.
 */
export function floatingPadCover(host: HTMLElement): number {
  const panel = host.parentElement?.querySelector<HTMLElement>(".pad-panel");
  if (!panel) return 0;
  const box = host.getBoundingClientRect();
  const top = panel.getBoundingClientRect().top;
  return Math.max(0, Math.min(box.height, box.bottom - top));
}

/**
 * What the compose field has grown by since its one-line height, the height the
 * terminal is sized under. A folded draft counts for the lines it still shows.
 */
function draftGrowth(pad: HTMLElement): number {
  const field = pad.querySelector<HTMLElement>(".full-terminal-compose-input");
  return field ? Math.max(0, field.offsetHeight - composeMinPx(field)) : 0;
}
