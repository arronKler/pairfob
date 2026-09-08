import { app, state, termLineHeightPx } from "../src/state";
import { isDesk } from "../src/viewport";

/** Exact main.ts route/class contract, without importing boot or network side effects. */
export function applyShell(): void {
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
}
