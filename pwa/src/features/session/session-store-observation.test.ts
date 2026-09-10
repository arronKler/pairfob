import { afterEach, describe, expect, test } from "bun:test";
import "../../../test-support/boot-dom";

const {
  applyPaneRead,
  clearSnapshotPending,
  lastSnapshotAt,
  noteSnapshotAt,
  paneReadBusy,
  paneReadPending,
  queueSnapshot,
  resetObservationLifecycle,
  resetPaneView,
  selectPane,
  sessionStore,
  setPaneReadBusy,
  setPaneReadPending,
  snapshotIsPending,
  takeQueuedSnapshot,
} = await import("./session-store");

afterEach(() => {
  resetObservationLifecycle();
  resetPaneView();
  selectPane("");
});

describe("session observation lifecycle", () => {
  test("queueing a Snapshot is idempotent and take consumes it once", () => {
    expect(snapshotIsPending()).toBe(false);
    queueSnapshot();
    queueSnapshot();
    expect(snapshotIsPending()).toBe(true);
    expect(sessionStore.get().snapshotPending).toBe(true);
    expect(takeQueuedSnapshot()).toBe(true);
    expect(snapshotIsPending()).toBe(false);
    expect(takeQueuedSnapshot()).toBe(false);
  });

  test("clearing a pending Snapshot does not start a fetch", () => {
    queueSnapshot();
    clearSnapshotPending();
    expect(snapshotIsPending()).toBe(false);
  });

  test("snapshot time and pane-read flags are named actions, not a patch bag", () => {
    noteSnapshotAt(1_000);
    noteSnapshotAt(1_000);
    expect(lastSnapshotAt()).toBe(1_000);
    setPaneReadBusy(true);
    setPaneReadBusy(true);
    setPaneReadPending(true);
    expect(paneReadBusy()).toBe(true);
    expect(paneReadPending()).toBe(true);
    applyPaneRead("hello", "h1");
    resetObservationLifecycle();
    expect(lastSnapshotAt()).toBe(0);
    expect(paneReadBusy()).toBe(false);
    expect(paneReadPending()).toBe(false);
    expect(snapshotIsPending()).toBe(false);
    expect(sessionStore.get().paneText).toBe("hello");
  });

  test("resetting the pane view does not drop a queued Snapshot", () => {
    queueSnapshot();
    noteSnapshotAt(9);
    resetPaneView();
    expect(snapshotIsPending()).toBe(true);
    expect(lastSnapshotAt()).toBe(9);
  });
});
