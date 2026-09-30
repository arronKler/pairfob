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
export type DeskChild = "chat" | "session" | null;

export type LayoutInput = {
  phase: Phase;
  screen: Screen;
  fullTerminal: boolean;
  agentChat: boolean;
  /** Wide layout: the list stays beside the page instead of stacking. */
  desk: boolean;
  /**
   * The only paired computer could not be reached (a network failure, not a
   * refusal): the phone explains it inside the list frame instead of the
   * computer picker. Optional so older callers keep the picker.
   */
  unreachable?: boolean;
  /** A pane is open and still reported by the daemon, so the desk can show it. */
  hasSelectedPane: boolean;
  termFontPx: number;
  operationBusy: boolean;
  /** The open pane was opened from the board, so leaving it goes back there. */
  boardReturn?: boolean;
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
  /** The pick phase renders the single-computer "cannot reach" page in the list frame. */
  unreachable: boolean;
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
  const desk = live && input.desk && !input.fullTerminal && !workspace;
  const session = live && input.screen === "pane" && (!desk || input.fullTerminal);
  const deskPage: DeskPage = desk && (input.screen === "settings" || input.screen === "quota"
    || input.screen === "computers" || input.screen === "board") ? input.screen : null;
  const deskChild: DeskChild = desk && !deskPage && input.hasSelectedPane
    ? input.agentChat ? "chat" : "session"
    : null;
  const deskReturn: DeskReturn = deskChild && input.boardReturn === true ? "board" : null;

  // The phone boots and reconnects inside the list's own frame (header,
  // placeholder rows, tab bar) so nothing jumps when the session goes live.
  const splash = booting && input.desk;
  const unreachable = input.phase === "pick" && input.unreachable === true && !input.desk;
  const tabs = (booting && !input.desk) || unreachable || (live && !input.desk && !input.fullTerminal
    && (input.screen === "home" || input.screen === "board" || input.screen === "settings"));
  const mode: LayoutMode = booting ? "boot"
    : input.phase === "connect" || input.phase === "pairing" ? "connect"
    : input.phase === "pick" ? "pick"
    : workspace ? "workspace"
    : board ? "board"
    : live && input.fullTerminal ? "full-terminal"
    : desk ? "desk"
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
    shell: { session, desk, workspace, board, booting: splash, tabs, unreachable },
    lockScroll: session || desk || workspace || board || splash,
    termFontPx: input.termFontPx,
    termLineHeightPx: termLineHeightPx(input.termFontPx),
    operationBusy: input.operationBusy,
    key: `${mode}:${input.phase}:${deskPage ?? "-"}:${deskChild ?? "-"}${tabs ? ":tabs" : ""}`,
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
    && left.shell.unreachable === right.shell.unreachable;
}
