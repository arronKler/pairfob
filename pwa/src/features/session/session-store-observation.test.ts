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
    expect(takeQueuedSnapshot()).toBe(true);
    expect(snapshotIsPending()).toBe(false);
    expect(takeQueuedSnapshot()).toBe(false);
  });

  test("flight flags steer the lanes without publishing the session", () => {
    const published = sessionStore.get();
    let notified = 0;
    const stop = sessionStore.subscribe(() => { notified += 1; });
    queueSnapshot();
    setPaneReadBusy(true);
    setPaneReadPending(true);
    takeQueuedSnapshot();
    stop();
    expect(notified).toBe(0);
    expect(sessionStore.get()).toBe(published);
    expect(paneReadBusy()).toBe(true);
    expect(paneReadPending()).toBe(true);
  });

  test("snapshot time publishes once per reading, and only when it moved", () => {
    let notified = 0;
    const stop = sessionStore.subscribe(() => { notified += 1; });
    noteSnapshotAt(7);
    noteSnapshotAt(7);
    stop();
    // Its publication is a reentry point the poll rechecks before applying what
    // it read; a repeated reading is not a second one.
    expect(notified).toBe(1);
    expect(sessionStore.get().snapshotAt).toBe(7);
    expect(lastSnapshotAt()).toBe(7);
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
