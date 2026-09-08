import { app, state, termLineHeightPx } from "../../state";
import { isDesk } from "../../viewport";
import { BoardScreen } from "./board";
import { renderDesk } from "../desk";
import { renderPane } from "../pane";
import { WorkspaceScreen } from "./workspace";
import { BootScreen } from "./boot";
import { ConnectScreen } from "./connect";
import { ComputersScreen } from "./computers";
import { HomeScreen, prepareHerdView } from "./home";
import { QuotaScreen } from "./agent-quota";
import { SettingsScreen } from "./settings";
import { renderReactScreen } from "./root";

function renderLive(): void {
  if (state.screen === "workspace") return renderReactScreen(<WorkspaceScreen />);
  if (state.screen === "board") return renderReactScreen(<BoardScreen />);
  if (state.fullTerminal) return renderPane();
  if (isDesk()) return renderDesk();
  if (state.screen === "settings") renderReactScreen(<SettingsScreen />);
  else if (state.screen === "quota") renderReactScreen(<QuotaScreen />);
  else if (state.screen === "computers") renderReactScreen(<ComputersScreen />);
  else if (state.screen === "pane") renderPane();
  else renderReactScreen(<HomeScreen view={prepareHerdView()} />);
}

export function renderApp(): void {
  const workspace = state.phase === "live" && state.screen === "workspace";
  const board = state.phase === "live" && state.screen === "board";
  const desk = state.phase === "live" && isDesk() && !state.fullTerminal && !workspace && !board;
  const session = state.phase === "live" && state.screen === "pane" && (!desk || state.fullTerminal);
  const booting = state.phase === "boot" || state.phase === "resuming";
  app.classList.toggle("session", session);
  app.classList.toggle("desk", desk);
  app.classList.toggle("workspace", workspace);
  app.classList.toggle("board", board);
  app.classList.toggle("boot-screen", booting);
  document.documentElement.classList.toggle("lock", session || desk || workspace || board || booting);
  document.body.classList.toggle("lock", session || desk || workspace || board || booting);
  app.style.setProperty("--term-fs", `${state.termFontPx}px`);
  app.style.setProperty("--term-lh", `${termLineHeightPx(state.termFontPx)}px`);
  app.setAttribute("aria-busy", state.operationBusy ? "true" : "false");
  if (booting) return renderReactScreen(<BootScreen />);
  if (state.phase === "connect" || state.phase === "pairing") return renderReactScreen(<ConnectScreen />);
  if (state.phase === "pick") renderReactScreen(<ComputersScreen />);
  else renderLive();
}
