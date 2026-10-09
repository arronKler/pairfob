import { useLayoutEffect, type RefObject } from "react";
import { isDesk } from "../../app/viewport";
import { diffNoteSendOpen } from "../../lib/diff-notes";
import { overlayOrigin } from "../../shared/ui/overlay/origin";
import { operationBusy } from "../operations/capabilities-store";
import { landings, noteLeft, rowControl, rowListShown, rowNeighbours, type Left, type RowPlace } from "./focus-landing";
import { getWorkspaceSnapshot } from "./store";

/**
 * Keeps the keyboard in a files surface while the reader works there.
 *
 * Focus drops to <body> more often than it looks: a menu, sheet or dialog
 * opened from the surface closes; the pressed row is replaced by the file it
 * opened; the pressed control disables itself while the read it started is
 * out; a browser that does not focus a clicked button never had it on the row
 * in the first place. Beside the session each of those would hand the next Esc
 * or Ctrl+C to the agent next door, and on the screen each makes the next Tab
 * start over. So while the reader's last press or focus was in the surface,
 * focus that falls to <body> is put back: on the control they last used if it
 * can take it, otherwise where a reader on the keyboard would look next
 * (`focus-landing`), otherwise where the surface rests.
 *
 * One loss is put right for every input: the row the reader was on is deleted
 * from its own menu, or drawn again by the reload that follows a rename. The
 * row, or the neighbour that took its place, has focus afterwards, so the next
 * Tab goes on from where the row was instead of from the top of the page, as it
 * does after any other answer to that menu.
 *
 * It steps aside as soon as the reader presses or focuses anywhere else.
 */

/** Top-layer surfaces. Going into one is a visit, not a move out of the surface. */
const OVERLAYS = "dialog, [popover], [role='dialog'], [role='menu'], [role='listbox']";
const FOCUSABLE = "button, a[href], input, textarea, select, summary, [tabindex]";

type Surface = {
  /** Keep focus only for a reader on the keyboard; a mouse or a finger leaves it on <body>. */
  keysOnly: boolean;
  /** Where focus waits, unseen, while nothing in the surface can take it; null to leave it on <body>. */
  park: HTMLElement | null;
  /** Where the keyboard rests when the reader's place is gone and nothing stands in for it. */
  rest(): HTMLElement | null;
};

const keyed = (): boolean => overlayOrigin()?.input === "key";

/** A read, a send or a file operation is still out: what it disabled takes the keyboard back when it lands. */
function busy(): boolean {
  const snapshot = getWorkspaceSnapshot();
  return snapshot.loading || snapshot.loadingMore || snapshot.loadingBranches || snapshot.media.status === "loading"
    || diffNoteSendOpen() || operationBusy();
}

/**
 * Focus is still somewhere a key can reach. A list hidden under the file it
 * opened keeps its row in the document, a control that disabled itself stays
 * where it is, and the engine takes its time to report the focus neither can
 * hold any longer.
 */
function holds(active: Element | null): boolean {
  if (!active || active === document.body || !active.isConnected || active.matches(":disabled")) return false;
  return typeof active.checkVisibility !== "function" || active.checkVisibility();
}

function take(target: HTMLElement | null | undefined): boolean {
  if (!target?.isConnected) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target && holds(target);
}

function keepFocusIn(root: HTMLElement, surface: Surface): () => void {
  let held = false;
  /** The control the reader last pressed or focused in the surface, and what it was. */
  let last: HTMLElement | null = null;
  let left: Left | null = null;
  /** Presses and keys anywhere on the page: what tells the reader's own move from focus put somewhere for them. */
  let inputs = 0;
  /** The row control the reader was last on, and the count of their inputs by then. */
  let onRow: { control: HTMLElement; row: RowPlace; inputs: number } | null = null;
  let timer = 0;

  const input = (): void => { inputs += 1; };

  const note = (event: Event): void => {
    // Icons are SVG elements, and a press usually lands on one.
    const target = event.target as Partial<Element> | null;
    if (typeof target?.closest !== "function") {
      held = false;
      return;
    }
    if (target.closest(OVERLAYS)) return;
    // Focus handed back to <body> is focus lost, not the reader going anywhere.
    if (event.type === "focusin" && (target === document.body || target === document.documentElement)) return;
    held = root.contains(target as Element);
    // Focus parked on the surface itself is this module waiting, not the reader choosing.
    if (event.type === "focusin" && target === root) return;
    const control = held ? target.closest(FOCUSABLE) : null;
    last = control instanceof HTMLElement && control !== root ? control : null;
    left = last ? noteLeft(last) : null;
    if (last && left?.row) onRow = { control: last, row: left.row, inputs };
  };

  /**
   * The row the reader was on, once the list has drawn it again or dropped it.
   * With focus lost, the control they last used says which. With focus put
   * somewhere since (the confirmation's own rule for a removed row sees a list
   * emptied by its reload, and lands above it), it is still their row as long
   * as they have pressed nothing in between.
   */
  const strandedRow = (lost: boolean): RowPlace | null => {
    if (lost && left?.row && !last?.isConnected) return left.row;
    return onRow && onRow.inputs === inputs && !onRow.control.isConnected ? onRow.row : null;
  };

  /** Put focus where the row is now, or where it was. True when that is settled, or still being read. */
  const settleRow = (row: RowPlace, lost: boolean): boolean => {
    // On a phone a finger is left alone, as for everything else on the screen.
    if (surface.keysOnly && !keyed() && !isDesk()) return false;
    if (!rowListShown(row)) return false;
    const same = rowControl(root, row);
    if (busy() && (!same || (same as Partial<HTMLButtonElement>).disabled === true)) {
      if (lost) surface.park?.focus({ preventScroll: true });
      return true;
    }
    return same ? take(same) : rowNeighbours(root, row).some(take);
  };

  const settle = (): void => {
    timer = 0;
    if (!held || !root.isConnected) return;
    // Something in the top layer still has the keyboard; its close comes back here.
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    // Parked focus is focus still waiting for its place.
    const lost = !holds(active) || active === surface.park;
    const row = strandedRow(lost);
    if (row && settleRow(row, lost)) return;
    if (!lost) return;
    const byKey = keyed();
    if (surface.keysOnly && !byKey) return;
    if (take(last)) return;
    const waiting = last?.isConnected && (last as Partial<HTMLButtonElement>).disabled === true && busy();
    // A reader on the keyboard goes on from somewhere: a pointer has no next place, and
    // a control focused for it would take the Enter or Space meant for nothing.
    if (!waiting && byKey && left && landings(root, left).some(take)) return;
    if (waiting || !root.contains(document.activeElement)) (waiting ? surface.park : surface.rest())?.focus({ preventScroll: true });
  };
  // Behind the task that closes a dialog: its own focus return runs first,
  // and a follow-up dialog queued by a menu row opens from wherever this lands.
  const check = (): void => {
    if (held && !timer) timer = window.setTimeout(settle, 0);
  };

  // Counted before `note` reads the count for the press it is told about.
  document.addEventListener("pointerdown", input, true);
  document.addEventListener("keydown", input, true);
  document.addEventListener("pointerdown", note, true);
  document.addEventListener("focusin", note);
  // Dialogs are portalled into <body>: one leaving is an overlay that closed.
  const overlays = new MutationObserver((records) => {
    if (records.some((record) => [...record.removedNodes].some((node) => node.nodeName === "DIALOG"))) check();
  });
  overlays.observe(document.body, { childList: true });
  // The surface replaced what held focus (a list by the file a row opened), or
  // disabled it, or let it take focus again.
  const content = new MutationObserver(check);
  content.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

  return () => {
    document.removeEventListener("pointerdown", input, true);
    document.removeEventListener("keydown", input, true);
    document.removeEventListener("pointerdown", note, true);
    document.removeEventListener("focusin", note);
    overlays.disconnect();
    content.disconnect();
    window.clearTimeout(timer);
  };
}

/**
 * The inspector beside the session, for every input: whatever the page
 * forwards to the session it decides by where focus is, so the column keeps
 * focus inside itself, on the column when nothing in it can hold it. It lets
 * go whenever the column shows another pane: choosing a session hands the
 * keyboard to that session.
 */
export function useInspectorFocus(column: RefObject<HTMLElement | null>, paneId: string): void {
  useLayoutEffect(() => {
    const root = column.current;
    if (!root) return;
    return keepFocusIn(root, { keysOnly: false, park: root, rest: () => root });
  }, [column, paneId]);
}

/**
 * The files screen, for a reader on the keyboard. No session is on the page to
 * take a stray key, so a pointer is left alone, as everywhere outside the desk
 * columns; a key that loses its place goes on from the detail it opened, the
 * row it came from, or Back.
 */
export function useScreenFocus(shell: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = shell.current;
    if (!root) return;
    return keepFocusIn(root, { keysOnly: true, park: null, rest: () => root.querySelector<HTMLElement>(".workspace-chrome .back") });
  }, [shell]);
}
