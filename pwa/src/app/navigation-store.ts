import { nextTransition, transitionFor, type TransitionKind } from "./transition";
import { batch, createDomain } from "../shared/model/domain-store";
import { boardStore, boardReturn, stageBoardReturnCleared } from "../features/board/layout-store";
import { composeTransaction } from "../shared/model/compose-transaction";

/**
 * Navigation domain: which page the application shows, and the transition the
 * next commit should animate. Screen selection is declarative — `app/App.tsx`
 * renders the page for the current screen — so a navigation is one typed action
 * here plus a paint, never a `root.render(screen)` call.
 */
export type Screen = "home" | "pane" | "workspace" | "settings" | "quota" | "computers" | "board";

export type NavigationRecord = {
  screen: Screen;
  /** Live computer-list back target. Home may still land on the open pane. */
  computersFrom: "home" | "settings";
};

const navigationDomain = createDomain<NavigationRecord>("navigation", {
  screen: "home",
  computersFrom: "home",
});
export const navigationStore = navigationDomain.store;
const { read, write, stage } = navigationDomain.controller;


export function currentScreen(): Screen {
  return read().screen;
}

export type NavigateOptions = {
  /** Explicit transition; defaults to the depth relation between the screens. */
  transition?: TransitionKind;
  /** Pane whose title/opening morphs during the transition, if any. */
  paneId?: string | null;
  /** Declare no transition even when the depth relation would infer one. */
  plain?: boolean;
};

/**
 * Move to a screen. The transition is declared here so the commit pipeline can
 * animate and measure it; callers do not queue transitions by hand.
 */
export function goToScreen(screen: Screen, options: NavigateOptions = {}): void {
  const from = read().screen;
  if (!options.plain) nextTransition(options.transition ?? transitionFor(from, screen), options.paneId);
  if (from === screen) return;
  composeTransaction([navigationStore], () => {
    stage((record) => {
      record.screen = screen;
    });
  });
}

/** Set the screen without declaring a transition (a poll or restore path). */
export function setScreen(screen: Screen): void {
  if (read().screen === screen) return;
  composeTransaction([navigationStore], () => {
    stage((record) => {
      record.screen = screen;
    });
  });
}

export function setComputersFrom(from: "home" | "settings"): void {
  if (read().computersFrom === from) return;
  write((record) => {
    record.computersFrom = from;
  });
}

/** Where the live computer list was opened from, read at action time. */
export function computersFrom(): "home" | "settings" {
  return read().computersFrom;
}

/**
 * Leave the pane for the screen it was opened from. A board opening collapses
 * back into its tile, so the board also drops its return flag here.
 */
export function leavePaneScreen(): void {
  const toBoard = boardReturn();
  composeTransaction([navigationStore, boardStore], () => {
    batch(() => {
      stageBoardReturnCleared();
      stage((record) => {
        record.screen = toBoard ? "board" : "home";
      });
    });
  });
}
