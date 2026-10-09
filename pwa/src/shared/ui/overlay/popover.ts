import { isDesk } from "../dom/width-tier";
import { overlayOrigin } from "./origin";
import { liveTrigger } from "./trigger";

/**
 * Anchored presentation: where a sheet opens when a mouse or the keyboard asked
 * for it on a desk layout.
 *
 * A `menu` is a flat list of commands: it opens at its trigger, or at the
 * pointer for a context click, sized to its rows. A `panel` keeps everything
 * the sheet holds (settings, pushed pages) and hangs under its trigger at a
 * fixed width. Both stay native modal dialogs in the top layer, so focus,
 * Escape and the inert page behind are the browser's; only the place, the size
 * and the scrim differ from the sheet.
 */
export type PopoverKind = "menu" | "panel";

export type Box = { left: number; top: number; right: number; bottom: number };
export type Placement = { left: number; top: number; maxHeight: number };

export type PopoverTarget = {
  kind: PopoverKind;
  /** The control that opened it, when one is still on screen. */
  anchor: Element | null;
  /**
   * The trigger's box as the opening gesture saw it. A row's hover actions fold
   * away once the modal popover makes the page inert, so the live box may have
   * collapsed by the time it is read.
   */
  box: Box | null;
  /** Where the mouse was; the last resort when the trigger has no box at all. */
  point: { x: number; y: number } | null;
  /** A context click: the popover belongs at `point`, not under the trigger. */
  atPoint: boolean;
};

/**
 * Whether a mouse or the keyboard did what the reader just did. A finger or a
 * pen gets the sheet at every width, and so does a page that remembers no
 * gesture.
 */
export function deskInput(): boolean {
  const input = overlayOrigin()?.input;
  return input === "mouse" || input === "key";
}

/**
 * Whether what the reader just did asks for a dialog's desk form: a mouse or
 * the keyboard opened it, and the layout has the list beside the page (the
 * shell's own tier, so a phone on its side stays a phone).
 */
export function deskPresentation(): boolean {
  return deskInput() && isDesk();
}

/** Open popovers, for callers that must tell them from a blocking modal. */
const POPOVER_OPEN = "dialog[open][data-popover]";

/**
 * What a trigger carries while its popover is open. The page behind is inert,
 * so the trigger cannot show hover; its owner keeps it (and a row's folded
 * actions) drawn as the open one by this mark.
 */
export const TRIGGER_OPEN = "data-popover-open";

const TRIGGER = "button, a, summary, [role='button'], [tabindex]";
const GAP = 6;
const EDGE = 8;
/** A panel under a low trigger still shows a few rows before it scrolls. */
const PANEL_MIN_HEIGHT = 160;

function laidOut(element: Element | null): Box | null {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
}

/**
 * Decide the presentation for one open. Null keeps the sheet: the caller did
 * not ask for a popover, the layout is a phone's, a finger or pen opened it, or
 * nothing on screen is left to anchor to.
 */
export function popoverTarget(kind: PopoverKind | undefined, anchor?: Element | null): PopoverTarget | null {
  const origin = overlayOrigin();
  if (!kind || !origin || !deskPresentation()) return null;
  const point = origin.input === "mouse" ? { x: origin.x, y: origin.y } : null;
  const pressed = origin.target?.closest(TRIGGER) ?? origin.target;
  const trigger = anchor?.isConnected ? anchor
    : pressed?.isConnected && pressed !== document.body && pressed !== document.documentElement ? pressed : null;
  // A follow-up menu whose trigger left with the menu before it opens where the reader clicked.
  if (!trigger && !point) return null;
  return { kind, anchor: trigger, box: laidOut(trigger), point, atPoint: !anchor && origin.atPointer && kind === "menu" && !!point };
}

/**
 * The box to place against, read again on every placement: the trigger where
 * it is now, else where the opening gesture saw it, else the pointer.
 */
export function popoverBox(target: PopoverTarget): { box: Box; atPoint: boolean } | null {
  const box = target.atPoint ? null : laidOut(target.anchor) ?? target.box;
  if (box) return { box, atPoint: false };
  if (!target.point) return null;
  const { x, y } = target.point;
  return { box: { left: x, right: x, top: y, bottom: y }, atPoint: true };
}

/**
 * A popover that stepped aside for the sheet, asked where it hangs now that
 * the list is beside the page again: from its trigger, or from the control the
 * layout drew in that trigger's place. Null when there is neither, and the
 * sheet comes back as the desk card instead: one button among several alike
 * that does not say whose it is cannot be told apart.
 *
 * A context click belonged to a point in a window that has since changed
 * shape, so the point is not gone back to. The row, heading or pane it was
 * made on is still what the menu is about, and the menu hangs from that
 * control's box, where the keyboard would have opened it. A context click on
 * something that is not a control has no such owner and is the card.
 *
 * The control drawn in the trigger's place is nobody's open trigger yet, and a
 * tool that shows only while its heading is pointed at has no box until it is:
 * it is measured as the open one, which is how it is about to be drawn.
 */
export function popoverReturn(target: PopoverTarget): PopoverTarget | null {
  if (target.atPoint && !target.anchor?.matches(TRIGGER)) return null;
  const anchor = liveTrigger(target.anchor);
  if (!anchor) return null;
  const marked = anchor.hasAttribute(TRIGGER_OPEN);
  if (!marked) anchor.setAttribute(TRIGGER_OPEN, target.kind);
  const box = laidOut(anchor);
  if (!marked) anchor.removeAttribute(TRIGGER_OPEN);
  return box ? { ...target, anchor, box, atPoint: false } : null;
}

/**
 * Whether the control an open popover belongs to has left the page: removed
 * from it, or still in it and no longer drawn (its column stepped aside, its
 * group folded, the layout that had it replaced by one that does not). A menu
 * left floating there offers commands about something the reader can no longer
 * see, where nothing says what they would act on.
 *
 * A control that is only folded away is not gone: a row's hover actions
 * collapse to nothing under the inert page and keep their place in the layout
 * (`TRIGGER_OPEN` draws them as the open one). A popover that opened at the
 * pointer over something that is not a control has no owner to lose.
 */
export function popoverOrphaned(target: PopoverTarget): boolean {
  const control = target.anchor;
  if (!control || (target.atPoint && !control.matches(TRIGGER))) return false;
  if (!control.isConnected) return true;
  return typeof control.checkVisibility === "function" && !control.checkVisibility();
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

/**
 * Place a popover of `size` inside `viewport`. A menu opens below its trigger
 * on the leading edge and flips above or onto the trailing edge when that side
 * has no room; at a point it opens down and right of the pointer and flips the
 * same way. A menu too tall for either side stands beside its trigger instead
 * of over it, so the row it is about stays in view. A panel always hangs
 * below, on the trailing edge, and scrolls inside the height that is left.
 */
export function placePopover(kind: PopoverKind, anchor: Box | null, size: { width: number; height: number },
  viewport: { width: number; height: number }, atPoint = false): Placement {
  const gap = atPoint ? 0 : GAP;
  const maxLeft = viewport.width - EDGE - size.width;
  // Nothing to hang from (a keyboard open whose trigger has no box): the middle of the window.
  if (!anchor) {
    const maxHeight = viewport.height - 2 * EDGE;
    return { left: clamp((viewport.width - size.width) / 2, EDGE, maxLeft),
      top: clamp((viewport.height - Math.min(size.height, maxHeight)) / 2, EDGE, viewport.height), maxHeight };
  }
  if (kind === "panel") {
    const top = clamp(anchor.bottom + gap, EDGE, viewport.height - EDGE - PANEL_MIN_HEIGHT);
    return { left: clamp(anchor.right - size.width, EDGE, maxLeft), top, maxHeight: viewport.height - EDGE - top };
  }
  const leading = anchor.left;
  const left = clamp(leading > maxLeft ? anchor.right - size.width : leading, EDGE, maxLeft);
  const maxHeight = viewport.height - 2 * EDGE;
  const height = Math.min(size.height, maxHeight);
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  if (below + height <= viewport.height - EDGE) return { left, top: below, maxHeight };
  if (above >= EDGE) return { left, top: above, maxHeight };
  const after = anchor.right + gap;
  const before = anchor.left - gap - size.width;
  // Over the trigger only when the window has no room on either side of it.
  const beside = after <= maxLeft ? after : before >= EDGE ? before : left;
  return { left: beside, top: clamp(beside === left ? below : anchor.top, EDGE, viewport.height - EDGE - height), maxHeight };
}

/**
 * Close every open popover the way Escape would. Their portals unmount and
 * focus returns on the queued native `close`; `after` runs on the task behind
 * the last one, so a surface opened there does not lose focus to the restore.
 */
export function dismissPopovers(after?: () => void): boolean {
  const open = [...document.querySelectorAll<HTMLDialogElement>(POPOVER_OPEN)];
  if (!open.length) return false;
  if (after) open.at(-1)!.addEventListener("close", () => window.setTimeout(after, 0), { once: true });
  for (const dialog of open) dialog.close("cancel");
  return true;
}
