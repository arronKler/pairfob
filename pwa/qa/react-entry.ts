// This module is requested only in mode=react, without loading reference-checkout UI imports.
import { renderApp } from "../src/ui/react/app-screen";
import { leaveReactScreen } from "../src/ui/react/root";
import { agentTitle } from "../src/lib/dashboard";
import { canInterruptAgent } from "../src/ui/chrome";
import { t } from "../src/lib/i18n";
import { selectedAgent, state } from "../src/state";
import { isDesk } from "../src/viewport";
import { publishFullTerminalView } from "../src/ui/full-terminal-view";
import { paintFullTerminalScreen } from "../src/ui/react/full-terminal";
import { applyShell } from "./shell";
import { record } from "./environment";

export function renderReactFixture(): void { renderApp(); }
export function resetReactFixture(): void { leaveReactScreen(); }

/** Same production JSX with a deliberately inactive camera/terminal resource boundary. */
export function renderReactTerminalShell(error: boolean): void {
  applyShell();
  const selected = selectedAgent();
  const action = (method: string) => () => { record("lifecycle", `terminalShell.${method}`); };
  publishFullTerminalView({ owner: `qa-shell:${state.paneId}`, paneId: state.paneId,
    title: selected ? agentTitle(selected) : t("title.terminal"),
    working: canInterruptAgent(selected?.status ?? ""), stage: error ? "error" : "loading",
    detail: error ? t("ft.stateError") : t("ft.preparing"), retry: error, busy: false,
    composeLive: state.composeLive, keyboardOpen: false });
  paintFullTerminalScreen({ onBack: action("back"), onWorkspace: action("workspace"), onMenu: action("menu"),
    onStop: action("stop"), onRetry: action("retry"),
    scroll: (...args) => { record("lifecycle", "terminalShell.scroll", args); }, pageLines: () => 23,
    engineActive: false,
    controls: { desk: isDesk(), sendKey: key => record("lifecycle", "terminalShell.key", [key]), sendCompose: () => false,
      keyboard: { toggle: action("keyboardToggle"), open: action("keyboardOpen"), close: action("keyboardClose"), isOpen: () => false } },
  });
}
