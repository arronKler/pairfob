import { COMPOSE_MIN_PX } from "../compose-store";
import { terminalViewportSize, usedWidth, type HostInner } from "./full-terminal-fit";

/**
 * The room the computer's terminal is sized against.
 *
 * Usually that is the box the renderer shows. Three things take part of that
 * box without being a reason to resize the computer's terminal: beside the
 * list, the inspector, which covers some of the column's width for as long as
 * it is open, and the key pad a mouse calls up for a moment, which takes some
 * of its height; and everywhere, a draft longer than one line, which takes a
 * row for every line until it is sent. All are measured back in here, so the
 * request is what it would be without them and only the window resizing (or a
 * keyboard on the glass) changes it. The renderer keeps the requested grid and
 * shows the part that fits (see the fit controller).
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
 * How much shorter the pad's passing parts made the terminal: the momentary key
 * pad, and the lines a draft has grown past its first. A pad already at its
 * ceiling scrolls instead of growing, so they can cost less than their own
 * height.
 */
function coveredHeight(host: HTMLElement): number {
  const pad = host.parentElement?.querySelector<HTMLElement>(".full-terminal-pad");
  if (!pad) return 0;
  const taken = momentaryKeysHeight(pad) + draftGrowth(pad);
  if (!(taken > 0)) return 0;
  const frame = pad.offsetHeight - pad.clientHeight;
  const without = Math.min(pad.offsetHeight, pad.scrollHeight + frame - taken);
  return Math.max(0, pad.offsetHeight - without);
}

function momentaryKeysHeight(pad: HTMLElement): number {
  const keys = pad.querySelector<HTMLElement>(".full-terminal-pad-controls.is-momentary");
  if (!keys) return 0;
  const style = window.getComputedStyle(keys);
  return keys.offsetHeight + (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
}

/**
 * What the compose field has grown by since its one-line height, the height the
 * terminal is sized under. A folded draft counts for the lines it still shows.
 */
function draftGrowth(pad: HTMLElement): number {
  const field = pad.querySelector<HTMLElement>(".full-terminal-compose-input");
  return field ? Math.max(0, field.offsetHeight - COMPOSE_MIN_PX) : 0;
}
