import type { Phase } from "../features/connection/connection-store";
import type { Screen } from "./navigation-store";
import { termLineHeightPx } from "../features/settings/preferences-store";

/**
 * Page/layout composition, as data.
 *
 * The application used to decide what to render inside the paint function, by
 * calling `root.render(screen)` for whichever branch matched. This module turns
 * that branch into a value: a pure function of domain state produces one
 * descriptor, `<App/>` renders the page it names, and the shell classes follow
 * from it. Nothing here reads the DOM or publishes anything.
 */
export type LayoutMode =
  | "boot"
  | "connect"
  | "pick"
  | "workspace"
  | "board"
  | "full-terminal"
  | "desk"
  | "settings"
  | "quota"
  | "computers"
  | "chat"
  | "pane"
  | "home";

/** What the desk main column shows: a settings-family page, the board, a pane, or nothing. */
export type DeskPage = "settings" | "quota" | "computers" | "board" | null;
/** Where the desk's pane leads back to: the board it was opened from, or nowhere. */
export type DeskReturn = "board" | null;
/** The session the desk main column shows: agent chat, the guided pane or the complete terminal. */
export type DeskChild = "chat" | "session" | "full" | null;

export type LayoutInput = {
  phase: Phase;
  screen: Screen;
  fullTerminal: boolean;
  agentChat: boolean;
  /** Wide layout: the list stays beside the page instead of stacking. */
  desk: boolean;
  /**
   * The only paired computer could not be reached (a network failure, not a
   * refusal): the page explains it instead of showing the computer picker, on
   * the phone inside the list frame. Optional so older callers keep the picker.
   */
  unreachable?: boolean;
  /** A pane is open and still reported by the daemon, so the desk can show it. */
  hasSelectedPane: boolean;
  termFontPx: number;
  operationBusy: boolean;
  /** The open pane was opened from the board, so leaving it goes back there. */
  boardReturn?: boolean;
  /** Room for three columns: the list, the session and the inspector side by side. */
  wide?: boolean;
  /** The reader opened the files-and-changes inspector beside the session. */
  inspector?: boolean;
  /** A phone-sized screen: wide when turned on its side, but with no height to share. */
  handheld?: boolean;
  /** The desk's narrowest tier: the list fits beside a session, not beside the board's canvas. */
  narrow?: boolean;
  /** A retry started from the "cannot reach" page is in flight; the phase is `resuming` meanwhile. */
  retrying?: boolean;
};

export type ShellFlags = {
  session: boolean;
  desk: boolean;
  workspace: boolean;
  board: boolean;
  /** The desktop splash while booting; the phone boots inside the list frame. */
  booting: boolean;
  /** Phone tab roots (home / board / settings) carry the bottom tab bar. */
  tabs: boolean;
  /**
   * The pick phase renders the single-computer "cannot reach" page in the list
   * frame: the phone's tab bar, or the desk's rail with the page in its main column.
   */
  unreachable: boolean;
  /** The inspector column sits beside the desk session. */
  inspector: boolean;
  /** The list gave its column to the inspector or the board; that page's header leads back to it. */
  railHidden: boolean;
};

export type LayoutDescriptor = {
  mode: LayoutMode;
  deskPage: DeskPage;
  deskChild: DeskChild;
  /** The desk pane's way back; the phone pane keeps its own back button. */
  deskReturn: DeskReturn;
  shell: ShellFlags;
  /** html/body scroll lock: the application owns the whole viewport. */
  lockScroll: boolean;
  termFontPx: number;
  termLineHeightPx: number;
  operationBusy: boolean;
  /** Identity of this composition; a change is a navigation, not a repaint. */
  key: string;
};

export function computeLayout(input: LayoutInput): LayoutDescriptor {
  const live = input.phase === "live";
  const booting = input.phase === "boot" || input.phase === "resuming";
  const workspace = live && input.screen === "workspace";
  // The phone board owns the whole screen; the wide board sits in the desk's
  // main column beside the list, like any other desk page.
  const board = live && input.screen === "board" && !input.desk;
  // Every session mode, the complete terminal included, stays beside the list.
  // A phone on its side is the exception: its terminal keeps the whole screen.
  const desk = live && input.desk && !workspace && !(input.fullTerminal && input.handheld === true);
  const session = live && input.screen === "pane" && !desk;
  const deskPage: DeskPage = desk && (input.screen === "settings" || input.screen === "quota"
    || input.screen === "computers" || input.screen === "board") ? input.screen : null;
  // The complete terminal keeps its page while its pane is briefly unreported,
  // exactly as it did when it owned the whole viewport.
  const deskChild: DeskChild = desk && !deskPage && input.fullTerminal ? "full"
    : desk && !deskPage && input.hasSelectedPane ? input.agentChat ? "chat" : "session"
    : null;
  // The inspector belongs to the session it sits beside; without three columns'
  // worth of room the list gives way to it.
  const inspector = deskChild !== null && input.inspector === true;
  // The board keeps its canvas: in the narrowest tier the list gives way to it
  // too, and the board's own header leads back.
  const railHidden = (inspector && input.wide !== true) || (deskPage === "board" && input.narrow === true);
  const deskReturn: DeskReturn = deskChild && input.boardReturn === true ? "board" : null;

  // The explanation of what cannot be reached keeps the list's frame at every
  // width: the phone's tab bar, the desk's rail beside it. The desk frame also
  // stays while the page's own retry runs, where the phone's boot frame takes over.
  const unreachable = input.phase === "pick" && input.unreachable === true;
  const offline = input.desk && (unreachable || (input.phase === "resuming" && input.retrying === true));
  // The phone boots and reconnects inside the list's own frame (header,
  // placeholder rows, tab bar) so nothing jumps when the session goes live.
  const splash = booting && input.desk && !offline;
  const tabs = (booting && !input.desk) || (unreachable && !input.desk) || (live && !input.desk && !input.fullTerminal
    && (input.screen === "home" || input.screen === "board" || input.screen === "settings"));
  const mode: LayoutMode = booting ? "boot"
    : input.phase === "connect" || input.phase === "pairing" ? "connect"
    : input.phase === "pick" ? "pick"
    : workspace ? "workspace"
    : board ? "board"
    : desk ? "desk"
    : live && input.fullTerminal ? "full-terminal"
    : input.screen === "settings" ? "settings"
    : input.screen === "quota" ? "quota"
    : input.screen === "computers" ? "computers"
    : input.screen === "pane" ? input.agentChat ? "chat" : "pane"
    : "home";

  return {
    mode,
    deskPage,
    deskChild,
    deskReturn,
    shell: { session, desk: desk || offline, workspace, board, booting: splash, tabs, unreachable, inspector, railHidden },
    lockScroll: session || desk || offline || workspace || board || splash,
    termFontPx: input.termFontPx,
    termLineHeightPx: termLineHeightPx(input.termFontPx),
    operationBusy: input.operationBusy,
    key: `${mode}:${input.phase}:${deskPage ?? "-"}:${deskChild ?? "-"}${tabs ? ":tabs" : ""}${offline ? ":offline" : ""}`,
  };
}

/** True when two descriptors describe the same page and the same shell inputs. */
export function layoutsEqual(left: LayoutDescriptor | null | undefined, right: LayoutDescriptor): boolean {
  if (!left) return false;
  return left.key === right.key
    && left.mode === right.mode
    && left.deskPage === right.deskPage
    && left.deskChild === right.deskChild
    && left.deskReturn === right.deskReturn
    && left.termFontPx === right.termFontPx
    && left.termLineHeightPx === right.termLineHeightPx
    && left.operationBusy === right.operationBusy
    && left.lockScroll === right.lockScroll
    && left.shell.session === right.shell.session
    && left.shell.desk === right.shell.desk
    && left.shell.workspace === right.shell.workspace
    && left.shell.board === right.shell.board
    && left.shell.booting === right.shell.booting
    && left.shell.tabs === right.shell.tabs
    && left.shell.unreachable === right.shell.unreachable
    && left.shell.inspector === right.shell.inspector
    && left.shell.railHidden === right.shell.railHidden;
}
