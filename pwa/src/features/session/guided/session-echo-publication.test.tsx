import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { mountTestApp, unmountTestApp, commitTest } from "../../../../test-support/react-harness";
import { applyPaneRead, livePaneText, livePaneHash, paneFollow, paneRow, paneUnread, resetPaneView, selectPane, sessionStore, setAgentChat, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect } from "../session-store";
import { setComposeDraft, setComposeFocused, setComposeIME } from "../compose-store";
import { setOperationBusy } from "../../operations/capabilities-store";
import { attachLiveSession, liveSession } from "../../computers/catalog-store";
import { applySnapshot } from "../../dashboard/catalog-store";
import { setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { getAppFrame } from "../../../app/frame";
import { compositionPublicationHeld } from "../../../shared/model/domain-store";
import { appRoot } from "../../../app/dom-root";
import { echoGhost, predictKeys, resetEcho, subscribeEcho } from "./echo";
import { markCaughtUp, unreadCount } from "./unread";
import { patchSessionScreen } from "./view";
import { sessionUIRevision } from "./ui-revision";
import { subscribeComposeView } from "./compose";

const SNAPSHOT = {
  workspaces: [{ workspace_id: "w1", label: "p1", cwd: "/repo" }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
  panes: [{
    pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo",
    agent: "codex", agent_status: "idle", history_available: true,
  }],
};
// applySnapshot seeds the dashboard and prunes daemon-scoped panes; capture the
// pre-seed canonical/raw/projection so afterEach restores exactly.
const snapshotRestorer = new WorkspaceSnapshotRestorer();

beforeEach(async () => {
  await resetBoardTestDOM();
  snapshotRestorer.capture();
  act(() => {
    resetPaneView(); setPhase("live"); setScreen("pane"); selectPane("p1");
    setAgentChat(false); setFullTerminal(false); applyPaneRead("a", "base");
    setTermSelect(false); setComposeDraft(""); setComposeIME(false); setComposeFocused(false);
    setOperationBusy(false); setPaneFollow(true); setPaneUnread(false);
    applySnapshot(SNAPSHOT);
    attachLiveSession({ isConnected: () => true });
  });
  mountTestApp();
  commitTest();
  act(() => resetEcho());
});
afterEach(async () => {
  await act(async () => { resetEcho(); unmountTestApp(); attachLiveSession(null); });
  // Restore the original navigation cleanup AFTER the App unmount but BEFORE the
  // restorer completes (unmountTestApp does not reset navigation/session domains;
  // do not clobber the restorer with later navigation changes).
  act(() => { setScreen("home"); selectPane(""); });
  act(() => snapshotRestorer.restore());
});

// Select a segment of a DOM text node without touching any domain store. Used to
// assert that an in-flight patch never rewrites the stale selection/DOM on an
// arriving composition.
function rangeSelect(node: Node | null): void {
  const selection = window.getSelection();
  if (!selection || !node) return;
  const range = document.createRange();
  try {
    range.setStart(node, 0);
    range.setEnd(node, Math.min(1, node.textContent?.length ?? 0));
  } catch {
    range.setStart(node, 0);
    range.setEnd(node, 0);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function offBottom(): HTMLElement {
  const term = appRoot().querySelector<HTMLElement>(".term")!;
  Object.defineProperties(term, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 100 },
  });
  term.scrollTop = 100;
  return term;
}

test("guided patch settles predicted text against the new authoritative pane read", async () => {
  let ghost;
  try {
    await act(async () => predictKeys("p1", ["y"], "base"));
    await act(async () => {
      applyPaneRead("ay", "new");
      expect(patchSessionScreen()).toBe("patched");
      // Assert the patch's own effect BEFORE any teardown/resetEcho, so a
      // cleanup-triggered finalize cannot masquerade as the patch evidence.
      expect(sessionStore.get().paneText).toBe("ay");
      expect(appRoot().querySelector(".term-inner")?.textContent).toBe("ay");
    });
    ghost = echoGhost("p1");
    expect(ghost).toEqual({ text: "", rollback: false });
    console.log(JSON.stringify({
      text: livePaneText(),
      snapshot: sessionStore.get().paneText,
      rendered: appRoot().querySelector(".term-inner")?.textContent,
      ghost,
    }));
  } finally {
    await act(async () => resetEcho());
  }
});

test("patchSessionScreen publishes the pane read before it builds the model and gates a held composition", () => {
  const source = readFileSync(fileURLToPath(new URL("./view.ts", import.meta.url)), "utf8");
  const patch = source.slice(source.indexOf("export function patchSessionScreen"), source.indexOf("export { sessionScroll"));
  const held = patch.indexOf("compositionPublicationHeld()");
  const apply = patch.indexOf("applyPaneRead(");
  const model = patch.indexOf("paneModel()");
  const noted = patch.indexOf("noteSnapshot(");
  const unread = patch.indexOf("setPaneUnread(unreadCount() > 0)");
  expect(held).toBeGreaterThan(-1);
  expect(apply).toBeGreaterThan(held);
  expect(model).toBeGreaterThan(apply);
  expect(noted).toBeGreaterThan(model);
  expect(unread).toBeGreaterThan(noted);
  expect(patch.indexOf("notifySessionUI()")).toBeGreaterThan(unread);
  expect(patch).not.toMatch(/flushDirtyDomains\(\);\s*\n\s*const term/);
  expect(patch).not.toContain("publishPendingDomains");
});

test("guided first unread update publishes its new count before deciding chip visibility", async () => {
  const term = appRoot().querySelector<HTMLElement>(".term")!;
  Object.defineProperties(term, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 100 },
  });
  term.scrollTop = 100;
  markCaughtUp("p1", ["a"]);
  await act(async () => {
    applyPaneRead("a\nnew", "new");
    expect(patchSessionScreen()).toBe("patched");
  });
  const result = {
    count: unreadCount(),
    published: sessionStore.get().paneUnread,
    hidden: appRoot().querySelector<HTMLButtonElement>(".term-jump")!.hidden,
  };
  console.log("GUIDED_UNREAD", JSON.stringify(result));
  expect(result.count).toBeGreaterThan(0);
  expect(result.published).toBeTrue();
  expect(result.hidden).toBeFalse();
});

test("a held session-only composition defers the patch and never notifies/rewrites the stale frame, DOM or selection", async () => {
  // Stage a session-only composition (selectPane). Under a mounted App this
  // composes + requests the App commit; the leaf patch must DEFER, never publish
  // a subset, never bump revision against the stale snapshot, and never rewrite
  // the old frame/DOM/selection while the hold is up.
  const term = appRoot().querySelector(".term")!;
  const span = appRoot().querySelector(".term-line > span");
  const textNode = span?.firstChild as Node | null;
  const frameBefore = getAppFrame().session?.paneId;
  const revisionBefore = sessionUIRevision();
  let deferred = false;
  await act(async () => {
    selectPane("p2");
    expect(compositionPublicationHeld()).toBeTrue();
    applyPaneRead("new bytes for p2", "p2");
    deferred = patchSessionScreen() === "deferred";
    // Key observations INSIDE the same act hold-window, before any release:
    expect(deferred).toBeTrue();
    expect(getAppFrame().session?.paneId).toBe(frameBefore);     // frame not advanced
    expect(appRoot().querySelector(".term")).toBe(term);         // DOM node not replaced
    expect(appRoot().querySelector(".term-line > span")?.firstChild).toBe(textNode);
    expect(sessionUIRevision()).toBe(revisionBefore);             // no stale notify bumped revision
    expect(sessionStore.get().paneId).toBe("p1");                // published pane still p1
  });
});

test("applyPaneRead marks live (canonical) bytes even when the published snapshot already matches, under a real held stage", async () => {
  let beforeCommit: { canonical: string; canonicalHash: string; published: string };
  await act(async () => {
    applyPaneRead("A", "ha");               // publish A/ha
    setFullTerminal(true);                 // real named stage -> session hold
    expect(compositionPublicationHeld()).toBeTrue();
    applyPaneRead("B", "hb");              // held write: live B/hb, published stays A/ha
    applyPaneRead("A", "ha");              // restore: live A/ha, published still A/ha
    beforeCommit = {
      canonical: livePaneText(),
      canonicalHash: livePaneHash(),
      published: sessionStore.get().paneText,
    };
  });
  expect(beforeCommit!).toEqual({ canonical: "A", canonicalHash: "ha", published: "A" });
  expect(sessionStore.get().paneText).toBe("A");
  // The real App commit publishes the held write and prepares the frame.
  await act(async () => commitTest());
  expect(sessionStore.get().paneText).toBe("A");
  expect(getAppFrame().session?.paneId).toBe("p1");
});

test("unchanged clean pane read retains a stable published snapshot without notification", () => {
  let before: ReturnType<typeof sessionStore.get>;
  let calls = 0;
  let stop: () => void;
  act(() => {
    applyPaneRead("same", "hash");
    before = sessionStore.get();
    stop = sessionStore.subscribe(() => { calls += 1; });
  });
  try {
    act(() => { applyPaneRead("same", "hash"); });
    expect(sessionStore.get() === before).toBeTrue();
    expect(calls).toBe(0);
  } finally {
    act(() => stop());
  }
});

test("a replacement live handle with no commit is never accepted; the patch reports missing terminal", () => {
  const term = appRoot().querySelector(".term")!;
  expect(term).not.toBeNull();
  // attachLiveSession replaces the live handle with no composition hold; the
  // committed frame still owns the old handle, so the canonical-owner bound is
  // false and a refresh patch must NOT accept the stale owner (never "patched").
  // No composition was staged, so the honest outcome is "missing", not a deferral.
  let outcome: "patched" | "deferred" | "missing" = "missing";
  act(() => {
    attachLiveSession({ isConnected: () => true });
    outcome = patchSessionScreen();
  });
  expect(liveSession()).not.toBeNull();
  expect(outcome).not.toBe("patched");
  expect(outcome).toBe("missing");
});

test("a subscriber staging a fresh composition during the patch's internal publish defers in-flight work", async () => {
  // Force the in-patch batch(setPaneFollow/setPaneUnread) to PUBLISH by putting
  // the terminal off-bottom (following=false; baseline follow=true), so the
  // patch's own named write notifies a sessionStore subscriber synchronously.
  const term = appRoot().querySelector<HTMLElement>(".term")!;
  Object.defineProperty(term, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(term, "clientHeight", { configurable: true, value: 100 });
  term.scrollTop = 100; // not at bottom -> following=false
  const span = appRoot().querySelector(".term-line > span");
  const textNode = span?.firstChild as Node | null;
  act(() => rangeSelect(textNode));
  const selectionText = window.getSelection()?.toString() ?? "";
  const framePane = getAppFrame().session?.paneId;

  let calls = 0;
  let stagedInsidePatch = false;
  const stop = sessionStore.subscribe(() => {
    calls += 1;
    if (calls === 1) return; // applyPaneRead's publish below; do not stage yet
    stagedInsidePatch = true; // the in-patch batch publish fired us
    selectPane("p2");
    setScreen("home");
  });
  let outcome: "patched" | "deferred" | "missing" = "missing";
  // Wrap the whole patch/assert/finally in ONE async act so its completion
  // catches the queued microtask commit (view batch -> subscriber selectPane ->
  // composeTransaction -> app/commit queueMicrotask) that otherwise escapes the
  // synchronous act. Original 7 assert/action/stop order preserved before the
  // callback's first yield.
  await act(async () => {
    try {
      act(() => applyPaneRead("ay", "new")); // publish notify #1 (subscriber sees calls=1, no stage)
      const before = calls;
      act(() => { outcome = patchSessionScreen(); }); // in-patch batch -> notify #2 -> stage
      expect(calls).toBe(before + 1);       // the in-patch notify fired synchronously
      expect(outcome).toBe("deferred");
      expect(stagedInsidePatch).toBeTrue();
      // The stale DOM/frame/selection were NOT written:
      expect(appRoot().querySelector(".term")).toBe(term);
      expect(appRoot().querySelector(".term-line > span")?.firstChild).toBe(textNode);
      expect(window.getSelection()?.toString()).toBe(selectionText);
      expect(getAppFrame().session?.paneId).toBe(framePane);
    } finally {
      act(() => stop());
    }
  });
});

test("echo settle subscriber staging mid-patch defers; subscriber follow/unread canonical survives", async () => {
  // Independent regression: settleEcho synchronously invokes subscribeEcho. Its
  // listener stages a fresh composition; the patch must defer at settleEcho
  // WITHOUT running noteSnapshot/batch, so the subscriber's genuine canonical
  // follow/unread survives.
  const term = offBottom();
  await act(async () => predictKeys("p1", ["y"], "base")); // pending prediction
  const span = appRoot().querySelector(".term-line > span");
  const textNode = span?.firstChild as Node | null;
  act(() => rangeSelect(textNode));
  const selectionText = window.getSelection()?.toString() ?? "";
  const framePane = getAppFrame().session?.paneId;

  let triggered = 0;
  const stop = subscribeEcho(() => {
    if (triggered) return;
    triggered += 1;
    selectPane("p2");
    setPaneFollow(true);
    setPaneUnread(false);
  });
  let actual: { triggered: number; outcome: string; hold: boolean; pane: string | undefined; canonicalFollow: boolean; canonicalUnread: boolean };
  await act(async () => {
    try {
      applyPaneRead("ay", "new"); // settleEcho resolves the pending prediction -> echo notify -> stage
      const outcome = patchSessionScreen();
      actual = {
        triggered, outcome, hold: compositionPublicationHeld(),
        pane: sessionStore.get().paneId, canonicalFollow: paneFollow(), canonicalUnread: paneUnread(),
      };
      expect(actual).toEqual({ triggered: 1, outcome: "deferred", hold: true, pane: "p1", canonicalFollow: true, canonicalUnread: false });
      // Stale DOM/frame/selection untouched:
      expect(appRoot().querySelector(".term")).toBe(term);
      expect(appRoot().querySelector(".term-line > span")?.firstChild).toBe(textNode);
      expect(window.getSelection()?.toString()).toBe(selectionText);
      expect(getAppFrame().session?.paneId).toBe(framePane);
    } finally {
      act(() => stop());
    }
  });
});

test("real empty-row prune subscriber staging mid-patch defers; follow/unread canonical survives", async () => {
  // Independent regression: discardEmptyPaneRow -> setPaneRow(null) publishes the
  // session store when a real selected row became empty. Its listener (guarded on
  // paneRow already null) stages a fresh composition; the patch must defer at
  // discardEmptyPaneRow before the stale follow/unread batch overwrites the
  // listener's canonical.
  offBottom();
  act(() => setPaneRow(0));
  const span = appRoot().querySelector(".term-line > span");
  const textNode = span?.firstChild as Node | null;
  act(() => rangeSelect(textNode));
  const selectionText = window.getSelection()?.toString() ?? "";
  const framePane = getAppFrame().session?.paneId;

  let triggered = 0;
  const stop = sessionStore.subscribe(() => {
    if (triggered || paneRow() !== null) return;
    triggered += 1;
    selectPane("p2");
    setPaneFollow(true);
    setPaneUnread(false);
  });
  let actual: { triggered: number; outcome: string; hold: boolean; pane: string | undefined; canonicalFollow: boolean; canonicalUnread: boolean };
  await act(async () => {
    try {
      applyPaneRead("", "empty"); // new read empties row 0 -> discardEmptyPaneRow -> setPaneRow(null) -> notify -> stage
      const outcome = patchSessionScreen();
      actual = {
        triggered, outcome, hold: compositionPublicationHeld(),
        pane: sessionStore.get().paneId, canonicalFollow: paneFollow(), canonicalUnread: paneUnread(),
      };
      expect(actual).toEqual({ triggered: 1, outcome: "deferred", hold: true, pane: "p1", canonicalFollow: true, canonicalUnread: false });
      // Stale DOM/frame/selection untouched:
      expect(appRoot().querySelector(".term-line > span")?.firstChild).toBe(textNode);
      expect(window.getSelection()?.toString()).toBe(selectionText);
      expect(getAppFrame().session?.paneId).toBe(framePane);
    } finally {
      act(() => stop());
    }
  });
});

test("ordinary real row prune remains a local successful patch", async () => {
  offBottom();
  await act(async () => {
    setPaneRow(0);
    applyPaneRead("", "empty");
    expect(patchSessionScreen()).toBe("patched");
    expect(paneRow()).toBeNull();
    expect(paneFollow()).toBeFalse();
  });
});

test("compose-view subscriber staging between syncSendButton and notifySessionUI keeps revision delta zero", async () => {
  // Independent regression: flushSync(syncSendButton) notifies subscribeComposeView;
  // its listener stages selectPane(p2). The patch must recheck the bound BETWEEN
  // syncSendButton and notifySessionUI and defer WITHOUT bumping the local
  // revision by the prohibited stale delta.
  const term = appRoot().querySelector(".term")!;
  const span = appRoot().querySelector(".term-line > span");
  const textNode = span?.firstChild as Node | null;
  act(() => rangeSelect(textNode));
  const selectionText = window.getSelection()?.toString() ?? "";
  const framePane = getAppFrame().session?.paneId;
  const revisionBefore = sessionUIRevision();

  let staged = false;
  const stop = subscribeComposeView(() => {
    if (staged) return;
    staged = true;
    selectPane("p2");
  });
  let outcome: "patched" | "deferred" | "missing" = "missing";
  await act(async () => {
    try {
      act(() => applyPaneRead("a", "base")); // no-op
      act(() => { outcome = patchSessionScreen(); }); // syncSendButton -> compose notify -> stage -> skip notify
      expect(staged).toBeTrue();
      expect(outcome).toBe("deferred");
      expect(sessionUIRevision()).toBe(revisionBefore); // stale revision delta 0
      expect(appRoot().querySelector(".term")).toBe(term);
      expect(appRoot().querySelector(".term-line > span")?.firstChild).toBe(textNode);
      expect(window.getSelection()?.toString()).toBe(selectionText);
      expect(getAppFrame().session?.paneId).toBe(framePane);
    } finally {
      act(() => stop());
    }
  });
});
