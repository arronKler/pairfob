import { clearPairingFragment } from "../connection/connection-store";
import {
  computers, computersStore, currentDaemonId, liveSession, setAddingComputer,
  setComputers, setCredential,
} from "./catalog-store";
import type { ComputersRecord } from "./catalog-store";
import type { SessionRecord } from "../session/session-store";
import { originProtocol, phase, setPhase, wsURL } from "../connection/connection-store";
import type { ConnectionRecord } from "../connection/connection-store";
import { currentScreen, goToScreen, setComputersFrom, setScreen } from "../../app/navigation-store";
import type { NavigationRecord } from "../../app/navigation-store";
import {
  clearPairErrorTarget, pairAbortHandle, setPairCodeDraft, setPairManualOpen,
} from "../pairing/form-store";
import { clearNotice, showStatus } from "../../app/notices-store";
import { batch, type DomainView } from "../../shared/model/domain-store";
import { bindSessionOwnerFromLive } from "../../features/session/bind-live";
import { commitView } from "../../app/host";
import { applyComposeDraft, bumpViewIncarnation, parkComposeView } from "../session/drafts/compose-drafts";
import { computerTitle } from "../../lib/computer-catalog";
import { deleteCredential, saveCredential } from "../../lib/credentials";
import { t } from "../../lib/i18n";
import { fragmentUsableOnOrigin, parsePairingFragment } from "../../lib/pairing-input";
import { pairOverWS, ProtocolError, type PairResult } from "../../lib/protocol/client";
import { friendlyDeviceLabel } from "../../lib/ui-model";
import { track } from "../../lib/telemetry";
import {
  closeComputerSession, establish, landAfterDisconnect, refreshFromSession, reloadComputers,
  startPolling, stopPolling,
} from "../connection/controller";
import { askConfirm } from "../../shared/ui/overlay/basic-dialogs";
import { forgetDaemonAttachments } from "../session/attachments/attachments-recovery";
import { retirePairingWork } from "../pairing/work";
import type { ComputersBackTarget, ComputersViewInput } from "./model";
import { advanceComputersFlow, computersFlowId } from "./work";
import { createMachineLinks } from "./machine-link";
import { capabilitiesStore, capabilityEnabled } from "../operations/capabilities-store";

/**
 * Computer controller — the feature's one connected adapter.
 *
 * Reads go through the domains' action-time selectors (`phase`,
 * `currentScreen`, `liveSession`, `currentDaemonId`, `computers`) and writes
 * through their actions, batched so a multi-field change notifies once.
 * Navigation goes through the navigation domain (`goToScreen`/`setScreen`) and
 * the navigation port; leaving or returning to the open pane parks/reapplies
 * the session-owned compose draft. The catalog reload publishes the computers
 * domain itself (`reloadComputers` batches setComputers after its
 * generation/attempt/shouldApply guards), so a mounted picker updates from its
 * own subscription — no facade adapter.
 */

/** Abort and clear the add-computer handshake input without the failure-step rail. */
function abortPairingInput(): void {
  pairAbortHandle()?.abort();
  setPairCodeDraft("");
  setPairManualOpen(false);
  clearPairErrorTarget();
}

/** Published snapshots the picker projects; callers subscribe first. */
export type ComputersPageSnapshots = {
  connection: DomainView<ConnectionRecord>;
  computers: DomainView<ComputersRecord, "live">;
  navigation: DomainView<NavigationRecord>;
  session: DomainView<SessionRecord>;
};

/**
 * Live inputs the computers page projects. The values come from the page's
 * subscribed domain snapshots, so a staged composition hold keeps the picker on
 * the same published phase/catalog as its frame; the canonical readers below
 * stay with the click/async handlers.
 */
export function computersPageInput(withBack: boolean, desk: boolean, snapshots: ComputersPageSnapshots): ComputersViewInput {
  const { connection, computers: computersSnapshot, navigation, session } = snapshots;
  return {
    computers: computersSnapshot.computers,
    credentialDaemonId: computersSnapshot.credential?.daemonId ?? null,
    live: connection.phase === "live",
    lastUsedDaemonId: computersSnapshot.lastUsedDaemonId,
    computersFrom: navigation.computersFrom,
    desk,
    paneId: session.paneId,
    withBack,
  };
}

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
  const screen = currentScreen();
  // Leaving the open pane parks its guided draft first: the return ceremony in
  // leaveComputers reapplies the parked text, so an entry that skips the park
  // would come back to an empty field.
  if (screen === "pane") parkComposeView();
  if (screen === "settings") setComputersFrom("settings");
  else if (screen !== "computers") setComputersFrom("home");
  goToScreen("computers");
  commitView();
}

export function leaveComputers(target: ComputersBackTarget): void {
  advanceComputersFlow();
  if (target === "pane") {
    // Returning to the open pane keeps the session-owned draft ceremony the
    // previous adoptScreen call performed: invalidate the view incarnation,
    // rebind the live owner and reapply the parked draft.
    bumpViewIncarnation();
    goToScreen("pane");
    bindSessionOwnerFromLive();
    applyComposeDraft();
  } else {
    goToScreen(target);
  }
  commitView();
}

export function beginAddComputer(): void {
  const current = phase();
  if (current === "pairing" || current === "resuming") return;
  advanceComputersFlow();
  abortPairingInput();
  track("pwa_add_computer");
  // Stop polling before publishing phase/notice. A visible-notice subscriber
  // can cancel Add synchronously and startPolling; an outer stop after that
  // would shut the restored owner down.
  stopPolling();
  batch(() => {
    clearPairingFragment();
    setAddingComputer(true);
    setPhase("connect");
    clearNotice();
  });
}

export function cancelAddComputer(): void {
  retirePairingWork();
  abortPairingInput();
  batch(() => {
    clearPairingFragment();
    setAddingComputer(false);
    clearNotice();
  });
  // Abort and notice publication can retire the session. Read the owner after
  // those side effects, not from a boolean captured before abort.
  if (liveSession() !== null) {
    batch(() => {
      setPhase("live");
      setScreen("computers");
    });
    startPolling();
    void refreshFromSession();
    return;
  }
  batch(() => {
    setPhase(computers().length ? "pick" : "connect");
    setScreen("home");
  });
}

export async function switchComputer(daemonId: string): Promise<void> {
  const current = phase();
  if (current === "resuming" || current === "pairing") return;
  const pair = computers().find(item => item.daemonId === daemonId);
  if (!pair) return;
  if (current === "live" && currentDaemonId() === daemonId) {
    advanceComputersFlow();
    goToScreen("home");
    commitView();
    return;
  }
  advanceComputersFlow();
  await resumeComputer(pair);
}

/**
 * After delete/reload, a forget must not land or toast if a later flow or
 * navigation intent owns the screen, or if a different computer is now
 * connected. Handle comparison alone cannot see Add: forget of the current
 * computer already cleared live/credential, so a new connect flow looks like
 * "no owner". The authorized deletion itself already happened and is not retried.
 */
export function forgetCompletionIsStale(input: {
  forgottenDaemonId: string;
  wasCurrent: boolean;
  ownerNow: string | null;
  sessionNow: object | null;
  sessionAtStart: object | null;
  flowAtStart: number;
  flowNow: number;
}): boolean {
  if (input.flowNow !== input.flowAtStart) return true;
  if (!input.wasCurrent) return false;
  if (input.ownerNow !== null && input.ownerNow !== input.forgottenDaemonId) return true;
  return input.sessionNow !== null && input.sessionNow !== input.sessionAtStart;
}

export async function forgetComputer(daemonId: string): Promise<void> {
  const pair = computers().find(item => item.daemonId === daemonId);
  const title = pair ? computerTitle(pair) : t("computers.this");
  if (!(await askConfirm({ title: t("confirm.forgetTitle"), subject: { name: title }, message: t("confirm.forgetEffect"),
    confirmLabel: t("forget") }))) {
    return;
  }
  const forgottenDaemonId = daemonId;
  const wasCurrent = currentDaemonId() === forgottenDaemonId;
  const sessionAtStart = liveSession();
  const flowAtStart = computersFlowId();
  closeComputerSession(forgottenDaemonId);
  if (wasCurrent) setCredential(null);
  await deleteCredential(forgottenDaemonId);
  // After the credential is gone, drop that daemon's attachment journal and
  // local rows (its epoch is marked before any await, so late writes can't
  // resurrect them). No server RPC; other daemons are preserved.
  await forgetDaemonAttachments(forgottenDaemonId);
  // reloadComputers publishes the fresh catalog through the computers domain
  // (batched after its load-generation guard); the stale-owner guard below
  // suppresses this completion's landing/toast for a replacement owner.
  await reloadComputers();
  if (forgetCompletionIsStale({
    forgottenDaemonId,
    wasCurrent,
    ownerNow: currentDaemonId(),
    sessionNow: liveSession(),
    sessionAtStart,
    flowAtStart,
    flowNow: computersFlowId(),
  })) return;
  batch(() => {
    if (!computers().length) {
      setPhase("connect");
      setAddingComputer(false);
      setScreen("home");
    } else if (wasCurrent || phase() !== "live") {
      setPhase("pick");
      setScreen("home");
    }
    showStatus(t("computers.forgot"));
  });
}

/**
 * A relayed link is trusted no further than a scanned one: it must be this
 * page's own `/pair` link and name its daemon and fingerprint, which the
 * handshake then checks.
 */
export async function pairFromMachineLink(pairUrl: string, signal: AbortSignal): Promise<PairResult> {
  let url: URL;
  try {
    url = new URL(pairUrl);
  } catch {
    throw new ProtocolError("bad_link");
  }
  const fragment = url.origin === location.origin && url.pathname === "/pair" ? parsePairingFragment(url.hash) : null;
  if (!fragment?.daemonId || !fragment.fingerprint || !fragmentUsableOnOrigin(fragment, originProtocol())) {
    throw new ProtocolError("bad_link");
  }
  return pairOverWS(wsURL({ daemonId: fragment.daemonId }), { pair_ref: fragment.pairRef }, fragment.code, {
    protocol: originProtocol(),
    expectedDaemonId: fragment.daemonId,
    expectedFingerprint: fragment.fingerprint,
    label: friendlyDeviceLabel(navigator.userAgent),
    signal,
  });
}

/** Machine links for the connected computer: its session, this device's catalog. */
export const machineLinks = createMachineLinks({
  session: liveSession,
  hostId: currentDaemonId,
  enabled: () => capabilityEnabled("link_machine"),
  confirmInstall: label => askConfirm({
    title: t("machines.installTitle"), subject: { name: label }, message: t("machines.installEffect"),
    confirmLabel: t("machines.install"), tone: "primary",
  }),
  pair: pairFromMachineLink,
  save: saveCredential,
  reload: () => reloadComputers(),
  announce: label => showStatus(t("machines.addedToast", { name: label })),
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
});

// List once per computer that advertises linking, so the phone's computer
// panel can offer its machines before the Computers page is ever opened. The
// grant and the connected computer are published by different domains, in
// either order, so both are watched.
let machinesListedFor = "";
function listMachinesForOwner(): void {
  const owner = capabilityEnabled("link_machine") && liveSession() ? currentDaemonId() ?? "" : "";
  if (owner === machinesListedFor) return;
  machinesListedFor = owner;
  void machineLinks.refresh();
}
capabilitiesStore.subscribe(listMachinesForOwner);
computersStore.subscribe(listMachinesForOwner);
