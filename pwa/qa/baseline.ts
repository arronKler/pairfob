// Reference-checkout adapter: typechecked against the immutable pre-migration tree.
import { app, selectedAgent, state } from "../src/state";
import { isDesk } from "../src/viewport";
import { computerTitle } from "../src/lib/computer-catalog";
import { agentTitle } from "../src/lib/dashboard";
import { node } from "../src/lib/dom";
import { t } from "../src/lib/i18n";
import { brandNode, spinnerNode } from "../src/ui/chrome";
import { renderConnect } from "../src/ui/connect";
import { renderComputers } from "../src/ui/computers";
import { renderHome } from "../src/ui/home";
import { renderDesk } from "../src/ui/desk";
import { renderPane } from "../src/ui/pane";
import { renderSettings } from "../src/ui/settings";
import { renderQuota } from "../src/ui/agent-quota";
import { renderBoard } from "../src/ui/board";
import { renderWorkspace } from "../src/ui/workspace";
import { createFullTerminalView } from "../src/ui/full-terminal-view";
import { syncFullTerminalChrome } from "../src/ui/full-terminal";
import { setFullTerminalDocumentMode, syncFullTerminalState } from "../src/ui/full-terminal-state";
import { syncFullTerminalControls } from "../src/ui/full-terminal-compose";
import { record } from "./environment";
import { applyShell } from "./shell";

export function renderBaselineFixture(): void {
  applyShell();
  if (state.phase === "boot" || state.phase === "resuming") {
    const root = node("div", "boot");
    root.append(brandNode(), spinnerNode(), node("p", "boot-text", state.phase === "boot" ? t("boot.reading")
      : t("boot.connecting", { name: state.credential ? computerTitle(state.credential) : t("boot.computer") })));
    app.replaceChildren(root);
    return;
  }
  if (state.phase === "connect" || state.phase === "pairing") return renderConnect();
  if (state.phase === "pick") return renderComputers();
  if (state.screen === "workspace") return renderWorkspace();
  if (state.screen === "board") return renderBoard();
  if (state.fullTerminal) return renderPane();
  if (isDesk()) return renderDesk();
  if (state.screen === "settings") renderSettings();
  else if (state.screen === "quota") renderQuota();
  else if (state.screen === "computers") renderComputers();
  else if (state.screen === "pane") renderPane();
  else renderHome();
}

/** Visual shell fixture only: deliberately never creates xterm or a TerminalOpen request. */
export function renderTerminalShell(error: boolean): void {
  applyShell();
  setFullTerminalDocumentMode(true);
  const action = (method: string) => () => { record("lifecycle", `terminalShell.${method}`); };
  const detail = error ? t("ft.stateError") : t("ft.preparing");
  const selected = selectedAgent();
  const { root } = createFullTerminalView(state.paneId, selected ? agentTitle(selected) : t("title.terminal"), detail, true, {
    onBack: action("back"), onWorkspace: action("workspace"), onMenu: action("menu"), onRetry: action("retry"),
    onScroll: (...args) => { record("lifecycle", "terminalShell.scroll", args); }, pageLines: () => 23,
  });
  syncFullTerminalControls(root, {
    desk: isDesk(), sendKey: (key) => record("lifecycle", "terminalShell.key", [key]), sendCompose: () => false,
    keyboard: { toggle: action("keyboardToggle"), open: action("keyboardOpen"), close: action("keyboardClose"), isOpen: () => false },
  });
  syncFullTerminalChrome(root);
  syncFullTerminalState(root, { stage: error ? "error" : "loading", detail, retry: error, busy: false });
  app.replaceChildren(root);
}
