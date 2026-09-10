import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyShell } from "../src/app/shell";
import { currentLayout } from "../src/app/layout-input";
import { appRoot } from "../src/app/dom-root";
import { releaseBoardScroll } from "../src/pages/board/pane-scroll";
import { canInterruptAgent } from "../src/features/connection/runtime-status";
import { agentTitle } from "../src/lib/dashboard";
import { t } from "../src/lib/i18n";
import { openPaneId } from "../src/features/session/session-store";
import { composeLive } from "../src/features/session/compose-store";
import { selectedAgent } from "../src/features/dashboard/catalog-store";
import { isDesk } from "../src/app/viewport";
import { registerSessionView } from "../src/features/session/register";
import { FullTerminalScreen } from "../src/features/session/full-terminal/full-terminal-screen";
import { setFullTerminalDocumentMode } from "../src/features/session/full-terminal/full-terminal-state";
import { publishFullTerminalView } from "../src/features/session/full-terminal/full-terminal-view";
import { record } from "./environment";

/**
 * Deliberately-owned QA standalone shell fixture for the two shell-only scenes
 * (`terminal-loading` / `terminal-error`).
 *
 * These scenes show the production FullTerminalScreen shell and its interactive
 * chrome WITHOUT ever starting xterm or issuing a TerminalOpen. Unlike the
 * retired production paint path, this fixture owns its OWN React root and its
 * full lifecycle: the root is created on `#app` only while the stable App is
 * unmounted, and `disposeTerminalShell` unmounts it before any scene mounts the
 * App again. It never touches the production legacy root and it
 * is not a second copy of the product shell (every class and the component
 * itself come from production modules).
 */

let shellRoot: Root | null = null;

/** True while the standalone shell fixture owns `#app`. */
export function terminalShellActive(): boolean {
  return shellRoot !== null;
}

export function renderTerminalShell(error: boolean): void {
  releaseBoardScroll();
  // Compose the shell the real App would apply for a live full-terminal page.
  applyShell(currentLayout());
  // Bind the production session owner exactly as the screen's paint path does.
  registerSessionView();
  setFullTerminalDocumentMode(true);
  const selected = selectedAgent();
  const action = (method: string) => () => { record("lifecycle", `terminalShell.${method}`); };
  publishFullTerminalView({
    owner: `qa-shell:${openPaneId()}`,
    paneId: openPaneId(),
    title: selected ? agentTitle(selected) : t("title.terminal"),
    working: selected ? canInterruptAgent(selected.status) : false,
    stage: error ? "error" : "loading",
    detail: error ? t("ft.stateError") : t("ft.preparing"),
    retry: error,
    busy: false,
    composeLive: composeLive(),
    keyboardOpen: false,
  });
  if (!shellRoot) shellRoot = createRoot(appRoot());
  shellRoot.render(
    createElement(FullTerminalScreen, {
      onBack: action("back"),
      onWorkspace: action("workspace"),
      onMenu: action("menu"),
      onStop: action("stop"),
      onRetry: action("retry"),
      scroll: (...args) => { record("lifecycle", "terminalShell.scroll", args); },
      pageLines: () => 23,
      engineActive: false,
      controls: {
        desk: isDesk(),
        sendKey: (key) => record("lifecycle", "terminalShell.key", [key]),
        sendCompose: () => false,
        keyboard: {
          toggle: action("keyboardToggle"), open: action("keyboardOpen"), close: action("keyboardClose"),
          isOpen: () => false,
        },
      },
    }),
  );
}

/**
 * Retire the standalone shell fixture and release `#app` for the stable App.
 * Idempotent: a no-op when no shell fixture is mounted.
 */
export function disposeTerminalShell(): void {
  if (!shellRoot) return;
  const root = shellRoot;
  shellRoot = null;
  setFullTerminalDocumentMode(false);
  root.unmount();
}
