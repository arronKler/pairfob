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

/** What the desk main column shows: a settings-family page, a pane, or nothing. */
export type DeskPage = "settings" | "quota" | "computers" | null;
export type DeskChild = "chat" | "session" | null;

export type LayoutInput = {
  phase: Phase;
  screen: Screen;
  fullTerminal: boolean;
  agentChat: boolean;
  /** Wide layout: the list stays beside the page instead of stacking. */
  desk: boolean;
  /** A pane is open and still reported by the daemon, so the desk can show it. */
  hasSelectedPane: boolean;
  termFontPx: number;
  operationBusy: boolean;
};

export type ShellFlags = {
  session: boolean;
  desk: boolean;
  workspace: boolean;
  board: boolean;
  booting: boolean;
};

export type LayoutDescriptor = {
  mode: LayoutMode;
  deskPage: DeskPage;
  deskChild: DeskChild;
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
  const board = live && input.screen === "board";
  const desk = live && input.desk && !input.fullTerminal && !workspace && !board;
  const session = live && input.screen === "pane" && (!desk || input.fullTerminal);
  const deskPage: DeskPage = desk && (input.screen === "settings" || input.screen === "quota"
    || input.screen === "computers") ? input.screen : null;
  const deskChild: DeskChild = desk && !deskPage && input.hasSelectedPane
    ? input.agentChat ? "chat" : "session"
    : null;

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
    shell: { session, desk, workspace, board, booting },
    lockScroll: session || desk || workspace || board || booting,
    termFontPx: input.termFontPx,
    termLineHeightPx: termLineHeightPx(input.termFontPx),
    operationBusy: input.operationBusy,
    key: `${mode}:${input.phase}:${deskPage ?? "-"}:${deskChild ?? "-"}`,
  };
}

/** True when two descriptors describe the same page and the same shell inputs. */
export function layoutsEqual(left: LayoutDescriptor | null | undefined, right: LayoutDescriptor): boolean {
  if (!left) return false;
  return left.key === right.key
    && left.mode === right.mode
    && left.deskPage === right.deskPage
    && left.deskChild === right.deskChild
    && left.termFontPx === right.termFontPx
    && left.termLineHeightPx === right.termLineHeightPx
    && left.operationBusy === right.operationBusy
    && left.lockScroll === right.lockScroll
    && left.shell.session === right.shell.session
    && left.shell.desk === right.shell.desk
    && left.shell.workspace === right.shell.workspace
    && left.shell.board === right.shell.board
    && left.shell.booting === right.shell.booting;
}
