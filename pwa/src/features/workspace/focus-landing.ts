import { ROOMY_QUERY } from "../../app/viewport";
import { overlayOrigin } from "../../shared/ui/overlay/origin";
import { getWorkspaceSnapshot } from "./store";

/**
 * Where a reader on the keyboard goes on from when the control they pressed is
 * no longer there to hold focus.
 *
 * Enter on a row replaces the list with the file it opened; Back, or Esc, puts
 * the list back in place of the file; the last step of a review disables the
 * button that made it. Each time the next key should start from where the
 * reader now is: the opened detail's own way back, the row they came from, the
 * step that is still open. `focus-keeper` asks here once focus is lost; closing
 * a detail asks directly, because Back outlives the detail it closed.
 *
 * A row of the list is a place of its own. A reload draws every row again, so
 * the row is known by what it lists (`data-trigger-of`, the key the overlays
 * follow a trigger by), not by its node; and when the file it listed is gone,
 * deleted from its own menu, the reader goes on from the row that took its
 * place: the next one, the one before when it was the last, the list's first
 * control when it was the only one.
 */

/** A control of a list row: whose row, which of its controls, and where the row stood. */
export type RowPlace = {
  /** What the row lists: a file's path, or a change's layer and path. */
  owner: string;
  /** The control's class in the row: the row itself, or its "more". */
  kind: string;
  /** Its position among the controls of that kind, top to bottom. */
  index: number;
  /** The listing it stood in: another directory or the other tab is another list, not this one changed. */
  list: string;
};

/** What the control the reader last used was, kept for when it is gone. */
export type Left = {
  /** A file or a diff was open. */
  detail: boolean;
  /** One of the review's previous/next steps. */
  step: boolean;
  /** Send, which the receipt replaces. */
  send: boolean;
  /** A row of the list, or its "more". */
  row: RowPlace | null;
};

const SURFACES = ".workspace-shell, .workspace-inspector";
const OWNER = "data-trigger-of";
const ROW_CONTROLS = [".workspace-row-main", ".workspace-row-more", ".workspace-change"];
/** The listing itself, under the tabs. */
const PANEL = ".workspace-panel";

/** The listing on screen, by what it lists. */
function shownList(): string {
  const { tab, directory } = getWorkspaceSnapshot();
  return tab === "files" ? `files:${directory}` : "changes";
}

function rowPlace(control: HTMLElement): RowPlace | null {
  const owner = control.getAttribute(OWNER);
  const kind = ROW_CONTROLS.find((selector) => control.matches(selector));
  const panel = control.closest(PANEL);
  if (owner === null || !kind || !panel) return null;
  return { owner, kind, index: [...panel.querySelectorAll(kind)].indexOf(control), list: shownList() };
}

/**
 * A file renamed from its row's menu: the row is the same place under its new
 * name. Kept until the reader is next seen on a row, which is then known by
 * the name it has.
 */
let renamed: { from: string; to: string } | null = null;

export function noteRowRenamed(from: string, to: string): void {
  renamed = { from, to };
}

export function noteLeft(control: HTMLElement): Left {
  const row = rowPlace(control);
  if (row && row.owner !== renamed?.from) renamed = null;
  return {
    detail: getWorkspaceSnapshot().view !== "browser",
    step: control.matches(".workspace-step"),
    send: control.matches(".workspace-notes-send"),
    row,
  };
}

/** The same control of the same row, as the list draws it now. */
export function rowControl(root: HTMLElement, place: RowPlace): HTMLElement | null {
  const owner = renamed?.from === place.owner ? renamed.to : place.owner;
  return [...root.querySelectorAll<HTMLElement>(`${PANEL} ${place.kind}`)].find((control) => control.getAttribute(OWNER) === owner) ?? null;
}

/**
 * The list the row stood in is the one on screen. Covered by a detail, or
 * showing another directory or the other tab, it says nothing about the row:
 * the row did not go anywhere, the reader did.
 */
export function rowListShown(place: RowPlace): boolean {
  return getWorkspaceSnapshot().view === "browser" && place.list === shownList();
}

/** Where to go on from a row its list no longer has, in order of preference. */
export function rowNeighbours(root: HTMLElement, place: RowPlace): Array<HTMLElement | null> {
  const alike = [...root.querySelectorAll<HTMLElement>(`${PANEL} ${place.kind}`)];
  return [
    // The row that moved up into its place, or the one above when it was the last.
    alike[place.index] ?? alike[alike.length - 1] ?? null,
    // No row of its kind is left: any row, then whatever the list starts with.
    root.querySelector<HTMLElement>(`${PANEL} :is(${ROW_CONTROLS.join(", ")}):not(:disabled)`),
    root.querySelector<HTMLElement>(`${PANEL} button:not(:disabled)`),
    root.querySelector<HTMLElement>("[role='tab'][aria-selected='true']"),
  ];
}

/** The list and what chooses it; a detail closed from here leaves focus where it is. */
const LIST = ".workspace-nav, .inspector-list, [role='tablist']";

/** The row the open, or just closed, file or diff was opened from, where the list shows one. */
function openedRow(root: HTMLElement): HTMLElement | null {
  const { detailPath, diffLayer, tab } = getWorkspaceSnapshot();
  if (!detailPath) return null;
  if (tab === "files") return root.querySelector<HTMLElement>(".workspace-row.active .workspace-row-main");
  const rows = [...root.querySelectorAll<HTMLElement>("[data-change]")];
  return rows.find((row) => row.dataset.change === `${diffLayer}:${detailPath}`)
    ?? rows.find((row) => row.dataset.change?.endsWith(`:${detailPath}`))
    ?? null;
}

/** The opened detail's first control: its way back to the list, or its own bar where the list never left. */
function detailEntry(root: HTMLElement): Array<HTMLElement | null> {
  if (root.matches(".workspace-inspector")) return [root.querySelector<HTMLElement>(".inspector-switch-file")];
  const back = root.querySelector<HTMLElement>(".workspace-chrome .back");
  const sideBySide = typeof window.matchMedia === "function" && window.matchMedia(ROOMY_QUERY).matches;
  if (!sideBySide) return [back];
  return [root.querySelector<HTMLElement>(".workspace-main .workspace-detail-head button:not(:disabled)"), back];
}

/** In order of preference; the first that can take focus does. */
export function landings(root: HTMLElement, left: Left): Array<HTMLElement | null> {
  const one = (selector: string) => root.querySelector<HTMLElement>(selector);
  if (getWorkspaceSnapshot().view !== "browser") {
    return [
      // The end of the review in one direction: the other is still open.
      left.step ? one(".workspace-step:not(:disabled)") : null,
      left.send ? one(".workspace-notes-bar.is-sent button") : null,
      ...detailEntry(root),
    ];
  }
  return [
    left.detail ? openedRow(root) : null,
    // A directory was entered, or left: its listing is where the reader is.
    one(".workspace-list .workspace-row-main:not(:disabled)"),
    one("[role='tab'][aria-selected='true']"),
  ];
}

/**
 * Call before closing a file or diff back to the list; call what it returns
 * once the list is committed. Closed with a key, the row it was opened from
 * takes the keyboard back, so the next arrow or Enter starts from there.
 */
export function focusClosingDetail(): () => void {
  const active = document.activeElement;
  const root = active instanceof HTMLElement ? active.closest<HTMLElement>(SURFACES) : null;
  if (overlayOrigin()?.input !== "key" || !root) return () => undefined;
  const left: Left = { detail: true, step: false, send: false, row: null };
  return () => {
    window.setTimeout(() => {
      if (!root.isConnected || document.querySelector("dialog[open]")) return;
      const now = document.activeElement;
      if (now instanceof HTMLElement && now.isConnected && now.closest(LIST)) return;
      for (const target of landings(root, left)) {
        target?.focus({ preventScroll: true });
        if (target && document.activeElement === target) return;
      }
    }, 0);
  };
}
