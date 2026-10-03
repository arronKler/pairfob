import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { batch } from "../../shared/model/domain-store";
import { attachLiveSession, computersStore, currentDaemonId, setCredential, setLastUsedDaemon } from "../computers/catalog-store";
import {
  capturePairingFragment, clearNotificationTarget, connectionStore, notificationTarget,
} from "../connection/connection-store";
import { applySnapshot, captureDashboardProjection, liveAgents } from "../dashboard/catalog-store";
import { currentScreen, navigationStore, setScreen, type Screen } from "../../app/navigation-store";
import { clearNotice, noticesStore, showError, showStatus, visibleNotice, type Notice } from "../../app/notices-store";
import { pairCodeDraft, setPairCodeDraft } from "../pairing/form-store";
import type { PairResult } from "../../lib/protocol/client";
import type { LiveSession } from "../../lib/protocol/session-types";
import { openPendingNotification } from "./notifications";

/**
 * Notification deep-link ownership (R3 regression).
 *
 * Consuming the target clears it, and that clear publishes: a subscriber can
 * attach a replacement computer while it runs. The captured owner must be
 * carried through consumption and revalidated before the pane dispatch — the
 * old intent never opens a pane under the replacement computer, and a
 * replacement's intent is never consumed.
 */

const scanDaemonId = "d_aaaaaaaaaaaaaaaaaaaa";
const credential = (id: string) => ({
  daemonId: id, deviceId: "device", label: "test", relayOrigin: "https://pairfob.com",
  createdAt: 1, fp: "fp", psk: new Uint8Array(32), daemonPk: new Uint8Array(32),
});

const originalLocation = globalThis.location;
const originalHistory = globalThis.history;
const alreadyDefault = async (): Promise<boolean> => { throw new Error("must not switch an already-default session"); };

/**
 * Foreign preimages of the fields the notification cases actually mutate,
 * captured before this suite's own seeds overwrite them so afterEach restores
 * the exact pre-case baseline through named owner actions. Runtime is never
 * written here, so it is left untouched. Dashboard uses its existing named
 * checkpoint (captureDashboardProjection).
 */
const checkpoint = {
  credential: null as PairResult | null,
  lastUsed: null as string | null,
  live: null as unknown as LiveSession | null,
  screen: "home" as Screen,
  notice: null as Notice | null,
  draft: "",
};
let restoreDashboard: (() => void) | null = null;

beforeEach(async () => {
  checkpoint.credential = computersStore.get().credential;
  checkpoint.lastUsed = computersStore.get().lastUsedDaemonId;
  checkpoint.live = computersStore.get().live;
  checkpoint.screen = navigationStore.get().screen;
  checkpoint.notice = noticesStore.get().notice;
  checkpoint.draft = pairCodeDraft();
  restoreDashboard = captureDashboardProjection();
  await resetBoardTestDOM();
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  batch(() => {
    setCredential(credential(scanDaemonId) as never);
    attachLiveSession({ isConnected: () => true } as never);
    applySnapshot({ panes: [{ pane_id: "p1", workspace_id: "w" }] });
  });
});

afterEach(() => {
  Object.assign(globalThis, { location: originalLocation, history: originalHistory });
  // Clear the consumed deep-link intent (the original named cleanup).
  clearNotificationTarget();
  // Restore the foreign preimages of the mutated fields through named owner
  // actions; the removed store.reset calls only dropped subscriber registries
  // and never touched the records. A foreign notice is replayed by its
  // text/tone/scope (a transient notice's original timer deadline cannot be
  // restored by the public replay APIs; the common preimage is null), and the
  // setCredential side effect on last-used is restored after the credential.
  setCredential(checkpoint.credential);
  setLastUsedDaemon(checkpoint.lastUsed);
  attachLiveSession(checkpoint.live);
  setScreen(checkpoint.screen);
  setPairCodeDraft(checkpoint.draft);
  if (checkpoint.notice) {
    if (checkpoint.notice.tone === "error") showError(checkpoint.notice.text, checkpoint.notice.scope, true);
    else showStatus(checkpoint.notice.text, true, checkpoint.notice.scope);
  } else {
    clearNotice();
  }
  restoreDashboard?.();
  restoreDashboard = null;
});

function captureNotify(daemonId: string, paneId: string): void {
  Object.assign(globalThis, {
    location: { hash: `#notify=1&d=${daemonId}&pane=${paneId}`, pathname: "/pair", search: "" },
    history: { replaceState() {} },
  });
  capturePairingFragment();
}

test("an ordinary notification opens its own computer's pane", async () => {
  captureNotify(scanDaemonId, "p1");
  const calls: string[] = [];
  const handled = await openPendingNotification(async (paneId) => {
    calls.push(`${currentDaemonId()}:${paneId}`);
  }, alreadyDefault);
  expect(handled).toBeTrue();
  expect(calls).toEqual([`${scanDaemonId}:p1`]);
  expect(notificationTarget()).toBeNull();
});

test("a notification whose computer is not current waits without consuming", async () => {
  captureNotify("d_bbbbbbbbbbbbbbbbbbbb", "p1");
  let opened = false;
  const handled = await openPendingNotification(async () => { opened = true; }, alreadyDefault);
  expect(handled).toBeFalse();
  expect(opened).toBeFalse();
  expect(notificationTarget()?.daemonId).toBe("d_bbbbbbbbbbbbbbbbbbbb");
});

test("a notification retired on the clear publication never opens a pane under the replacement computer", async () => {
  captureNotify(scanDaemonId, "p1");
  expect(notificationTarget()?.paneId).toBe("p1");
  let fired = false;
  const calls: string[] = [];
  const stop = connectionStore.subscribe(() => {
    if (fired || notificationTarget()) return;
    fired = true;
    setCredential(credential("B") as never);
    attachLiveSession({ isConnected: () => true } as never);
  });
  try {
    const handled = await openPendingNotification(async (paneId) => {
      calls.push(`${currentDaemonId()}:${paneId}`);
    }, alreadyDefault);
    expect(handled).toBeTrue();
    expect(fired).toBeTrue();
    expect(calls).toEqual([]);
    expect(liveAgents().length).toBe(1);
  } finally {
    stop();
  }
});

test("a missing pane for the still-current computer navigates home with a notice", async () => {
  captureNotify(scanDaemonId, "gone");
  const handled = await openPendingNotification(async () => {
    throw new Error("must not open a pane that no longer exists");
  }, alreadyDefault);
  expect(handled).toBeTrue();
  expect(currentScreen()).toBe("home");
});

test("a newer deep link captured during consumption replaces the old intent: the old pane never dispatches", async () => {
  // The subscriber captures a link for a replacement computer and opens it
  // immediately. The older continuation retires even though its clear already
  // happened; the newer intent keeps its target, screen and notice.
  captureNotify(scanDaemonId, "gone");
  let fired = false;
  const calls: string[] = [];
  const open = async (paneId: string): Promise<void> => {
    calls.push(paneId);
  };
  const stop = connectionStore.subscribe(() => {
    if (fired || notificationTarget()) return;
    fired = true;
    setCredential(credential("d_bbbbbbbbbbbbbbbbbbbb") as never);
    attachLiveSession({ isConnected: () => true } as never);
    setScreen("settings");
    showStatus("B own notice", true);
    captureNotify("d_bbbbbbbbbbbbbbbbbbbb", "p2");
  });
  try {
    const handled = await openPendingNotification(open, alreadyDefault);
    expect(handled).toBeTrue();
    expect(fired).toBeTrue();
    expect(calls).toEqual([]);
    expect(currentScreen()).toBe("settings");
    expect(visibleNotice()?.text).toBe("B own notice");
    // The newer intent was NOT consumed by the old continuation.
    expect(notificationTarget()?.paneId).toBe("p2");
  } finally {
    stop();
  }
});

test("a nested newer same-owner notification wins: only the newer pane dispatches", async () => {
  batch(() => {
    applySnapshot({ panes: [{ pane_id: "p1", workspace_id: "w" }, { pane_id: "p2", workspace_id: "w" }] });
  });
  captureNotify(scanDaemonId, "p1");
  let fired = false;
  const calls: string[] = [];
  const open = async (paneId: string): Promise<void> => {
    calls.push(paneId);
  };
  let nested: Promise<boolean> | undefined;
  const stop = connectionStore.subscribe(() => {
    if (fired || notificationTarget()) return;
    fired = true;
    captureNotify(scanDaemonId, "p2");
    nested = openPendingNotification(open, alreadyDefault);
  });
  try {
    const handled = await openPendingNotification(open, alreadyDefault);
    await nested;
    expect(handled).toBeTrue();
    expect(fired).toBeTrue();
    expect(calls).toEqual(["p2"]);
    expect(notificationTarget()).toBeNull();
  } finally {
    stop();
  }
});

test("the missing-navigation publication cannot overwrite a replacement owner's notice", async () => {
  // Start away from home so the missing-branch goToScreen("home") actually
  // navigates and publishes; the case must not rely on a previous test leaving
  // the screen off home (the afterEach restores it to home by named action,
  // and the navigation record is only the canonical screen, not a registry).
  setScreen("quota");
  captureNotify(scanDaemonId, "gone");
  let fired = false;
  const stop = navigationStore.subscribe(() => {
    if (fired || currentScreen() !== "home") return;
    fired = true;
    setCredential(credential("d_bbbbbbbbbbbbbbbbbbbb") as never);
    attachLiveSession({ isConnected: () => true } as never);
    setScreen("settings");
    showStatus("B own notice", true);
  });
  try {
    const handled = await openPendingNotification(async () => {
      throw new Error("a missing pane must never dispatch");
    }, alreadyDefault);
    expect(handled).toBeTrue();
    expect(fired).toBeTrue();
    expect(currentScreen()).toBe("settings");
    expect(visibleNotice()?.text).toBe("B own notice");
  } finally {
    stop();
  }
});

test("a notification sharing a named pane id opens only the default pane after switching", async () => {
  let herd: string | null = "work";
  attachLiveSession({ isConnected: () => true, herdSession: () => herd } as never);
  applySnapshot({ session: "work", panes: [{ pane_id: "p1", workspace_id: "work" }] });
  captureNotify(scanDaemonId, "p1");
  const calls: string[] = [];
  const open = async (paneId: string) => { calls.push(`open:${herd ?? "default"}:${paneId}`); };
  const switchDefault = async () => {
    calls.push("switch");
    expect(notificationTarget()?.paneId).toBe("p1");
    herd = null;
    applySnapshot({ session: "default", panes: [{ pane_id: "p1", workspace_id: "default" }] });
    await openPendingNotification(open, switchDefault);
    return true;
  };
  expect(await openPendingNotification(open, switchDefault)).toBe(true);
  expect(calls).toEqual(["switch", "open:default:p1"]);
  expect(notificationTarget()).toBeNull();
});

test("a pane missing from default reports gone only after leaving the named session", async () => {
  let herd: string | null = "work";
  attachLiveSession({ isConnected: () => true, herdSession: () => herd } as never);
  applySnapshot({ session: "work", panes: [{ pane_id: "p1", workspace_id: "work" }] });
  clearNotice();
  captureNotify(scanDaemonId, "p1");
  let switched = false;
  const open = async () => { throw new Error("default has no target pane"); };
  const switchDefault = async () => {
    switched = true;
    expect(notificationTarget()?.paneId).toBe("p1");
    expect(visibleNotice()).toBeNull();
    herd = null;
    applySnapshot({ session: "default", panes: [] });
    await openPendingNotification(open, switchDefault);
    return true;
  };
  await openPendingNotification(open, switchDefault);
  expect(switched).toBe(true);
  expect(visibleNotice()?.text).toBe((await import("../../lib/i18n")).t("err.notifyGone"));
});

test("a newer notification captured during the default switch owns the eventual pane", async () => {
  let herd: string | null = "work";
  attachLiveSession({ isConnected: () => true, herdSession: () => herd } as never);
  applySnapshot({ session: "work", panes: [{ pane_id: "p1", workspace_id: "work" }] });
  captureNotify(scanDaemonId, "p1");
  let finishSwitch!: () => void;
  const barrier = new Promise<void>(resolve => { finishSwitch = resolve; });
  const opened: string[] = [];
  const open = async (paneId: string) => { opened.push(`${herd ?? "default"}:${paneId}`); };
  const switchDefault = async () => {
    await barrier;
    herd = null;
    applySnapshot({ session: "default", panes: [{ pane_id: "p1", workspace_id: "default" }, { pane_id: "p2", workspace_id: "default" }] });
    await openPendingNotification(open, switchDefault);
    return true;
  };
  const pending = openPendingNotification(open, switchDefault);
  captureNotify(scanDaemonId, "p2");
  finishSwitch();
  await pending;
  expect(opened).toEqual(["default:p2"]);
  expect(notificationTarget()).toBeNull();
});

test("a superseded default switch leaves the intent pending without resolving or looping", async () => {
  attachLiveSession({ isConnected: () => true, herdSession: () => "work" } as never);
  captureNotify(scanDaemonId, "p1");
  let switches = 0;
  const opened: string[] = [];
  await openPendingNotification(async paneId => { opened.push(paneId); }, async () => { switches++; return false; });
  expect(switches).toBe(1);
  expect(opened).toEqual([]);
  expect(notificationTarget()?.paneId).toBe("p1");
});
