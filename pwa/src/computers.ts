import { computerTitle } from "./lib/computer-catalog";
import { deleteCredential } from "./lib/credentials";
import { askConfirm } from "./lib/dom";
import { t } from "./lib/i18n";
import { ProtocolError, type PairResult } from "./lib/protocol/client";
import {
  closeComputerSession,
  establish,
  landAfterDisconnect,
  reloadComputers,
  refreshFromSession,
  startPolling,
  stopPolling,
} from "./live";
import { render } from "./paint";
import { clearNotice, showStatus, state } from "./state";
import { track } from "./lib/telemetry";

export async function resumeComputer(pair: PairResult): Promise<void> {
  track("pwa_resume", { extra: "start" });
  try {
    await establish(pair);
    track("pwa_resume", { result: "ok" });
  } catch (error) {
    await landAfterDisconnect({
      daemonId: pair.daemonId,
      error: error instanceof ProtocolError ? error : new ProtocolError("disconnected", t("err.computerConnect")),
    });
  }
}

export function openComputers(): void {
  state.screen = "computers";
  render();
}

export function beginAddComputer(): void {
  if (state.phase === "pairing" || state.phase === "resuming") return;
  state.pairAbort?.abort();
  state.fragment = null;
  state.pairCodeDraft = "";
  state.pairManualOpen = false;
  state.pairErrorTarget = null;
  state.addingComputer = true;
  track("pwa_add_computer");
  stopPolling();
  state.phase = "connect";
  clearNotice();
  render();
}

export function cancelAddComputer(): void {
  state.pairAbort?.abort();
  state.addingComputer = false;
  state.fragment = null;
  state.pairCodeDraft = "";
  state.pairManualOpen = false;
  state.pairErrorTarget = null;
  clearNotice();
  if (state.live) {
    state.phase = "live";
    state.screen = state.computers.length > 1 ? "computers" : "settings";
    startPolling();
    void refreshFromSession();
    render();
    return;
  }
  state.phase = state.computers.length ? "pick" : "connect";
  state.screen = "home";
  render();
}

export async function switchComputer(daemonId: string): Promise<void> {
  if (state.phase === "resuming" || state.phase === "pairing") return;
  const pair = state.computers.find((item) => item.daemonId === daemonId);
  if (!pair) return;
  if (state.phase === "live" && state.credential?.daemonId === daemonId) {
    state.screen = "home";
    render();
    return;
  }
  await resumeComputer(pair);
}

export async function forgetComputer(daemonId: string): Promise<void> {
  const pair = state.computers.find((item) => item.daemonId === daemonId);
  const title = pair ? computerTitle(pair) : t("computers.this");
  if (!(await askConfirm(t("computers.forgetAsk", { title }), t("forget")))) {
    return;
  }
  const forgettingCurrent = state.credential?.daemonId === daemonId;
  closeComputerSession(daemonId);
  if (forgettingCurrent) state.credential = null;
  await deleteCredential(daemonId);
  await reloadComputers();
  if (!state.computers.length) {
    state.phase = "connect";
    state.addingComputer = false;
    state.screen = "home";
  } else if (forgettingCurrent || state.phase !== "live") {
    state.phase = "pick";
    state.screen = "home";
  }
  showStatus(t("computers.forgot"));
  render();
}
