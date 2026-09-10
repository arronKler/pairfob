import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { commitTest, mountTestApp, unmountTestApp } from "../../../test-support/react-harness";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { appRoot } from "../../app/dom-root";
import { setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations.ts";
import type { LiveSession } from "../../lib/protocol/session-types";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { currentScreen, setScreen } from "../../app/navigation-store";
import { openPaneId, selectPane } from "../../features/session/session-store";
import {
  listGroup,
  panePinned,
  resetHerdPresentationChoices,
  setListGroup,
  togglePanePin,
  LIST_GROUP_KEY,
} from "../../features/settings/preferences-store";
import { applyRuntimeIdentity, runtimeStore } from "../../features/connection/runtime-store";
import { clearNotice, showStatus } from "../../app/notices-store";
import { resetHerdAttention } from "../../lib/herd-attention";
import { WorkspaceSnapshotRestorer } from "../../../test-support/workspace-snapshot-restore";
import { type ListGroup } from "../../lib/ranking";

const app = appRoot;

// The dashboard/board projections and the pane-preferences pruners inside the
// herd seed also rewrite values a previous consumer installed (term modes,
// compose-live raw maps). Capture before seeding and restore after own teardown
// so those foreign canonical maps and raw preimages survive this fixture.
const foreign = new WorkspaceSnapshotRestorer();

// listGroup raw and the runtime herdHost are also overwritten by this fixture's
// boot (space -> flat, external host -> ""). Captured once per case entry before
// boot/seed, restored after own teardown via the named setter + exact raw.
let foreignGroup: ListGroup = "flat";
let foreignGroupRaw: string | null = null;
let foreignHost = "";
let foreignKind = "";
let foreignCaptured = false;
function captureForeignExtras(): void {
  if (foreignCaptured) return;
  foreignCaptured = true;
  foreignGroup = listGroup();
  foreignGroupRaw = localStorage.getItem(LIST_GROUP_KEY);
  foreignHost = runtimeStore.get().herdHost;
  foreignKind = runtimeStore.get().runtimeKind;
}
function restoreForeignExtras(): void {
  if (!foreignCaptured) return;
  applyRuntimeIdentity({ herdHost: foreignHost, runtimeKind: foreignKind });
  setListGroup(foreignGroup);
  if (foreignGroupRaw === null) localStorage.removeItem(LIST_GROUP_KEY);
  else localStorage.setItem(LIST_GROUP_KEY, foreignGroupRaw);
  foreignCaptured = false;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  foreign.capture();
  captureForeignExtras();
  setLang("zh");
});

/** The three herd rows, driven through the dashboard owner action. */
function seedAgents(): void {
  replaceAgentsFromSnapshot({
    workspaces: [
      { workspace_id: "w1", label: "alpha", cwd: "/tmp/a" },
      { workspace_id: "w2", label: "beta", cwd: "/tmp/b" },
    ],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", label: "main" },
      { tab_id: "t2", workspace_id: "w2", label: "review" },
    ],
    panes: [
      { pane_id: "p1", agent: "claude", agent_status: "idle", workspace_id: "w1", tab_id: "t1", label: "one", cwd: "/tmp/a" },
      { pane_id: "p2", agent: "claude", agent_status: "idle", workspace_id: "w2", tab_id: "t2", label: "two", cwd: "/tmp/b" },
      { pane_id: "p2b", agent: "claude", agent_status: "idle", workspace_id: "w2", tab_id: "t2", label: "two-b", cwd: "/tmp/b" },
    ],
  });
}

/** Boot phase, seed, attach the live session, then mount the actual App and commit. */
function boot(): void {
  setPhase("live");
  setScreen("home");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
  setNetworkOnline(true);
  setOperationBusy(false);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  selectPane("p1");
  seedAgents();
  attachLiveSession({
    isConnected: () => true,
    snapshot: async () => ({ panes: [] }),
    closePane: async () => undefined,
    closeTab: async () => undefined,
    renamePane: async () => undefined,
    renameTab: async () => undefined,
    renameWorkspace: async () => undefined,
  } as unknown as LiveSession);
  mountTestApp();
  commitTest();
}

/**
 * The sheet defers its action to a task after the native close and React
 * teardown. Wait for the outcome that action produces, bounded, instead of a
 * fixed delay: a slow combined run used to outrun a 10 ms guess while the same
 * case passed in isolation.
 */
async function settledBy(outcome: () => boolean, tasks = 50): Promise<void> {
  for (let attempt = 0; attempt < tasks; attempt += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (outcome()) return;
  }
}

function cardNamed(name: string): HTMLButtonElement {
  const root = app();
  const card = [...root.querySelectorAll(".card-main")].find((button) => button.textContent?.includes(name));
  if (!(card instanceof HTMLButtonElement)) throw new Error(`missing card ${name}`);
  return card;
}

afterEach(async () => await act(async () => {
  closeTestDialogs();
  await Promise.resolve();
  unmountTestApp();
  attachLiveSession(null);
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  clearNotice();
  app().replaceChildren();
  foreign.restore();
  restoreForeignExtras();
}));

describe("session list object controls", () => {
  test("app notices sit above the session cards", async () => await act(async () => {
    boot();
    showStatus("网络已恢复，正在确认连接…", true);
    commitTest();
    const page = app().querySelector(".page");
    const children = page ? [...page.children] : [];
    const noticeIdx = children.findIndex((el) => el.hasAttribute("data-app-notice"));
    const listIdx = children.findIndex((el) => el.classList.contains("herd-list"));
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(noticeIdx);
  }));

  test("the card is a single open control with no trailing menu button", async () => await act(async () => {
    boot();
    expect(app().querySelectorAll("article.card")).toHaveLength(3);
    expect(app().querySelector(".card-more")).toBeNull();
    expect(app().querySelector(".card-split")).toBeNull();
    expect(cardNamed("one").getAttribute("aria-haspopup")).toBe("menu");
  }));

  test("an unknown agent status shows the unknown pill and is not Needs you", async () => await act(async () => {
    boot();
    replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "alpha", cwd: "/tmp/a" }],
      tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [{ pane_id: "p1", agent: "claude", agent_status: "unknown", workspace_id: "w1", tab_id: "t1", label: "one", cwd: "/tmp/a" }],
    });
    commitTest();
    const card = cardNamed("one").closest("article.card");
    expect(card?.classList.contains("status-unknown")).toBe(true);
    expect(card?.classList.contains("status-blocked")).toBe(false);
    const pill = card?.querySelector(".pill-unknown");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("未知");
    expect(pill?.textContent).not.toBe("空闲");
    expect(card?.querySelector(".pill-idle")).toBeNull();
  }));

  test("a default tab is not offered rename; a named or split tab is", async () => await act(async () => {
    boot();
    cardNamed("one").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const plain = document.querySelector("dialog.sheet");
    expect(plain?.querySelector(".modal-title")?.textContent).toBe("one");
    const facts = plain?.querySelector(".sheet-facts")?.textContent ?? "";
    expect(facts).toContain("空闲");
    expect(facts).toContain("claude");
    expect(facts).toContain("/tmp/a");
    expect(facts).toContain("alpha");
    expect(facts).not.toContain("p1");
    expect(plain?.textContent).toContain("改会话名");
    expect(plain?.textContent).toContain("关闭这个会话");
    expect(plain?.textContent).not.toContain("改标签页名");
    expect(plain?.textContent).not.toContain("关闭整个标签页");
    expect(plain?.textContent).toContain("改工作区名");
    expect(plain?.textContent).toContain("关闭这个工作区");
    expect(plain?.textContent).not.toContain("在同一工作区再开一页");
    expect(plain?.textContent).not.toContain("分屏");
    expect(plain?.textContent).not.toContain("取消");
    (plain as HTMLDialogElement | null)?.close("cancel");

    cardNamed("two").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const split = document.querySelector("dialog.sheet");
    expect(split?.querySelector(".sheet-facts")?.textContent).toContain("review");
    expect(split?.querySelector(".sheet-facts")?.textContent).toContain("2 格");
    expect(split?.textContent).toContain("改标签页名");
    expect(split?.textContent).toContain("关闭整个标签页");
  }));

  test("a hold opens the menu and does not navigate", async () => await act(async () => {
    boot();
    const opened = openPaneId();
    const card = cardNamed("two");
    card.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", isPrimary: true, button: 0, clientX: 20, clientY: 20 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector("dialog.sheet")?.querySelector(".modal-title")?.textContent).toBe("two");
    card.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", isPrimary: true, button: 0, clientX: 20, clientY: 20 }));
    card.click();
    expect(openPaneId()).toBe(opened);
    expect(currentScreen()).toBe("home");
  }));

  test("workspace grouping moves rename off the card and onto the heading", async () => await act(async () => {
    boot();
    setListGroup("space");
    commitTest();
    const heading = [...app().querySelectorAll(".group-title")].find((el) => el.textContent?.includes("alpha"));
    if (!(heading instanceof HTMLButtonElement)) throw new Error("missing workspace heading");
    heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const sheet = document.querySelector("dialog.sheet");
    expect(sheet?.querySelector(".modal-title")?.textContent).toBe("alpha");
    expect(sheet?.textContent).toContain("改工作区名");
    expect(sheet?.textContent).toContain("关闭这个工作区");
    expect(sheet?.textContent).not.toContain("改会话名");
    expect(sheet?.textContent).not.toContain("在这个工作区新建标签页");
    (sheet as HTMLDialogElement | null)?.close("cancel");

    cardNamed("one").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const cardSheet = document.querySelector("dialog.sheet");
    expect(cardSheet?.textContent).toContain("改会话名");
    expect(cardSheet?.textContent).not.toContain("改工作区名");
    expect(cardSheet?.textContent).not.toContain("关闭这个工作区");
  }));

  test("create_tab offers another tab on the card and the workspace heading", async () => await act(async () => {
    boot();
    applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []);
    commitTest();
    cardNamed("one").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const card = document.querySelector("dialog.sheet");
    expect(card?.textContent).toContain("在同一工作区再开一页");
    expect(card?.textContent).not.toContain("分屏");
    expect(card?.textContent).not.toContain("在这个工作区新建标签页");
    (card as HTMLDialogElement | null)?.close("cancel");

    setListGroup("space");
    commitTest();
    const heading = [...app().querySelectorAll(".group-title")].find((el) => el.textContent?.includes("alpha"));
    if (!(heading instanceof HTMLButtonElement)) throw new Error("missing workspace heading");
    heading.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const group = document.querySelector("dialog.sheet");
    expect(group?.textContent).toContain("在这个工作区新建标签页");
    expect(group?.textContent).toContain("改工作区名");
    expect(group?.textContent).toContain("关闭这个工作区");
    expect(group?.textContent).not.toContain("分屏");
    expect(group?.textContent).not.toContain("改会话名");
  }));

  test("pinning a session puts it in the pinned section at the top", async () => await act(async () => {
    boot();
    cardNamed("two").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const pin = [...document.querySelectorAll("dialog.sheet .menu-item")].find((el) => el.textContent === "置顶");
    if (!(pin instanceof HTMLButtonElement)) throw new Error("missing pin action");
    pin.click();
    await settledBy(() => app().querySelector("article.card.pinned") !== null);
    const titles = [...app().querySelectorAll(".section-title")].map((el) => el.textContent);
    expect(titles[0]).toContain("置顶");
    const first = app().querySelector("article.card");
    expect(first?.classList.contains("pinned")).toBe(true);
    expect(first?.textContent).toContain("two");
    expect(first?.querySelector(".pin-mark")).not.toBeNull();

    cardNamed("two").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const unpin = [...document.querySelectorAll("dialog.sheet .menu-item")].find((el) => el.textContent === "取消置顶");
    if (!(unpin instanceof HTMLButtonElement)) throw new Error("missing unpin action");
    unpin.click();
    await settledBy(() => app().querySelector("article.card.pinned") === null && !document.querySelector("dialog.sheet"));
    expect([...app().querySelectorAll(".section-title")].map((el) => el.textContent).join("")).not.toContain("置顶");
    expect(app().querySelector("article.card.pinned")).toBeNull();
  }));
});

describe("session list pin persistence", () => {
  test("an empty snapshot does not drop pins; missing panes do", async () => await act(async () => {
    boot();
    // Named pins carry their own recency timestamps; capture the full object so
    // the preservation contract checks the timestamp values, not just the keys.
    togglePanePin("p1");
    togglePanePin("p2");
    const beforePins = panePinned();
    expect(Object.keys(beforePins).sort()).toEqual(["p1", "p2"]);
    // An empty snapshot preserves both pins with their exact timestamps.
    replaceAgentsFromSnapshot({ panes: [] });
    expect(panePinned()).toEqual(beforePins);
    // A fold that lists only p2 prunes p1; p2 survives with its original value.
    replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w", label: "W", cwd: "/" }],
      tabs: [{ tab_id: "t", workspace_id: "w", label: "main" }],
      panes: [{ pane_id: "p2", workspace_id: "w", tab_id: "t", agent: "claude", agent_status: "idle", label: "two", cwd: "/" }],
    });
    const afterPins = panePinned();
    expect(Object.keys(afterPins)).toEqual(["p2"]);
    expect(afterPins.p2).toBe(beforePins.p2);
    expect("p1" in afterPins).toBe(false);
    expect(listGroup()).toBe("flat");
  }));
});