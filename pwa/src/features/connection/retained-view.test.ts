import { beforeEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";
import type { LiveSession } from "../../lib/protocol/session-types";
import type { PairResult } from "../../lib/protocol/client";
import { attachLiveSession, setCredential } from "../computers/catalog-store";
import { applySnapshot, dashboardStore, resetDashboard } from "../dashboard/catalog-store";
import { applyRuntimeIdentity, resetRuntime, runtimeStore } from "./runtime-store";
import {
  adoptRetainedView,
  forgetRetainedView,
  resetRetainedViewsForTests,
  retainLiveView,
  retainedViewFor,
} from "./retained-view";

function pair(daemonId: string, deviceId = `phone_${daemonId}`, fp = `fp_${daemonId}`): PairResult {
  return { daemonId, deviceId, psk: new Uint8Array(32), daemonPk: new Uint8Array(32), relayOrigin: "http://local", fp, label: daemonId, createdAt: 1 };
}

function fakeSession(herd: string | null = null): LiveSession {
  return { herdSession: () => herd, close: () => undefined } as unknown as LiveSession;
}

function snap(paneId: string, status = "idle") {
  return { panes: [{ pane_id: paneId, workspace_id: "w", tab_id: "t", agent: "codex", agent_status: status }] };
}

function painted(credential: PairResult, paneId: string, herd: string | null = null): LiveSession {
  setCredential(credential);
  const session = fakeSession(herd);
  attachLiveSession(session);
  applySnapshot(snap(paneId));
  applyRuntimeIdentity({ herdHost: credential.label, runtimeKind: "herdr" });
  return session;
}

beforeEach(() => {
  resetRetainedViewsForTests();
  resetDashboard();
  resetRuntime();
  attachLiveSession(null);
  setCredential(null);
});

describe("a computer's kept view", () => {
  test("is kept only after a list was painted", () => {
    const a = pair("a");
    setCredential(a);
    attachLiveSession(fakeSession());
    retainLiveView();
    expect(retainedViewFor(a, null)).toBeNull();

    applySnapshot(snap("a1"));
    applyRuntimeIdentity({ herdHost: "a", runtimeKind: "herdr" });
    retainLiveView();

    const kept = retainedViewFor(a, null);
    expect(kept?.dashboard.agents.map((agent) => agent.paneId)).toEqual(["a1"]);
    expect(kept?.identity).toEqual({ herdHost: "a", runtimeKind: "herdr" });
  });

  test("never replaces a painted list with an unread one", () => {
    const a = pair("a");
    painted(a, "a1");
    retainLiveView();
    resetDashboard();
    retainLiveView();
    expect(retainedViewFor(a, null)?.dashboard.agents.map((agent) => agent.paneId)).toEqual(["a1"]);
  });

  test("answers only for the credential and Herdr session it was read from", () => {
    const a = pair("a");
    painted(a, "a1", "work");
    retainLiveView();

    expect(retainedViewFor(a, "other")).toBeNull();
    expect(retainedViewFor(pair("a", "phone_new"), "work")).toBeNull();
    expect(retainedViewFor(pair("a", "phone_a", "fp_new"), "work")).toBeNull();
    // A rejected lookup drops it: the credential it belonged to is gone.
    expect(retainedViewFor(a, "work")).toBeNull();
  });

  test("is adopted only under the credential that names its computer", () => {
    const a = pair("a");
    painted(a, "a1");
    retainLiveView();
    const kept = retainedViewFor(a, null)!;

    resetDashboard();
    setCredential(pair("b"));
    expect(adoptRetainedView(kept)).toBeFalse();
    expect(dashboardStore.get().agents).toEqual([]);

    setCredential(a);
    expect(adoptRetainedView(kept)).toBeTrue();
    expect(dashboardStore.get().agents.map((agent) => agent.paneId)).toEqual(["a1"]);
    expect(dashboardStore.get().snapshotLoaded).toBeTrue();
    expect(runtimeStore.get().herdHost).toBe("a");
    expect(runtimeStore.get().runtimeKind).toBe("herdr");
  });

  test("is forgotten with the computer it belongs to", () => {
    const a = pair("a");
    painted(a, "a1");
    retainLiveView();
    forgetRetainedView(a.daemonId);
    expect(retainedViewFor(a, null)).toBeNull();
  });

  test("is bounded, and keeps the most recent computers", () => {
    for (const id of ["a", "b", "c", "d"]) {
      resetDashboard();
      painted(pair(id), `${id}1`);
      retainLiveView();
    }
    expect(retainedViewFor(pair("a"), null)).toBeNull();
    for (const id of ["b", "c", "d"]) expect(retainedViewFor(pair(id), null)).not.toBeNull();
  });

  test("keeps and adopts without touching storage", () => {
    const writes: string[] = [];
    const setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key: string, value: string) => {
      writes.push(key);
      setItem(key, value);
    };
    try {
      const a = pair("a");
      painted(a, "a1");
      retainLiveView();
      resetDashboard();
      setCredential(a);
      adoptRetainedView(retainedViewFor(a, null)!);
      expect(writes).toEqual([]);
    } finally {
      localStorage.setItem = setItem;
    }
  });
});
