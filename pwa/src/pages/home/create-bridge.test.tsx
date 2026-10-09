import { happy, resetBoardTestDOM } from "../../../test-support/dom";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setScreen } from "../../app/navigation-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { CREATE_MEMORY_KEY, rememberCreate } from "../../features/operations/create-memory";
import { setLang, t } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import { bindOverlayOrigin } from "../../shared/ui/overlay/origin";
import { openQuickCreate } from "./create-bridge";

/**
 * The recent combinations by the gesture that asks: a menu at the button for a
 * mouse or the keyboard on a desk layout, the sheet for a finger, and one
 * create per picked row either way.
 */
let created: unknown[];
let release = () => {};
let trigger: HTMLButtonElement;

const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sheet = () => document.querySelector<HTMLDialogElement>("dialog[data-react-action-sheet]")!;
const rows = () => [...sheet().querySelectorAll<HTMLButtonElement>(".sheet-body .menu-choice")];
const texts = () => rows().map(row => [row.querySelector(".menu-choice-title")?.textContent, row.querySelector(".menu-choice-detail")?.textContent ?? ""]);

function press(pointerType: string, init: Record<string, unknown> = {}): void {
  trigger.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType, clientX: 270, clientY: 28, ...init }) as unknown as Event);
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  setScreen("home");
  setOperationBusy(false);
  resetDashboard();
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  localStorage.removeItem(CREATE_MEMORY_KEY);
  created = [];
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true, create_conversation: true }, ["claude", "codex"]);
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "pairfob", cwd: "/work/pairfob" }, { workspace_id: "w2", label: "site", cwd: "/work/site" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }, { tab_id: "t2", workspace_id: "w2", label: "main" }],
    panes: [
      { pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "claude", agent_status: "idle", cwd: "/work/pairfob" },
      { pane_id: "p2", workspace_id: "w2", tab_id: "t2", agent: "", agent_status: "idle", cwd: "/work/site" },
    ],
  });
  attachLiveSession({
    isConnected: () => true,
    snapshot: async () => ({}),
    createTab: async (input: unknown) => {
      created.push(input);
      return { operation_id: "op_tab000000000001", workspace_id: "w1", tab_id: "t9", pane_id: "p9", outcome: "applied" };
    },
  } as never);
  // Oldest first: the list leads with the latest combination.
  rememberCreate({ kind: "", workspaceId: "w2" });
  rememberCreate({ kind: "codex", workspaceId: "gone" });
  rememberCreate({ kind: "claude", workspaceId: "w1" });
  trigger = document.createElement("button");
  trigger.getBoundingClientRect = () => ({ left: 258, top: 12, right: 290, bottom: 44, width: 32, height: 32, x: 258, y: 12, toJSON() {} });
  document.body.append(trigger);
  release = bindOverlayOrigin(document);
});

afterEach(async () => {
  await act(async () => { closeTestDialogs(); await pause(); });
  release();
  trigger.remove();
  attachLiveSession(null);
  setOperationBusy(false);
  localStorage.removeItem(CREATE_MEMORY_KEY);
  happy.happyDOM.setWindowSize({ width: 390, height: 844 });
});

test("a mouse gets the recent combinations as a menu under the button, then the way to the full sheet", () => {
  press("mouse");
  act(() => openQuickCreate(trigger));
  expect(sheet().className).toBe("modal sheet popover popover-menu");
  expect([sheet().style.left, sheet().style.top]).toEqual(["258px", "50px"]);
  expect(sheet().querySelector(".sheet-body")?.getAttribute("role")).toBe("menu");
  // A combination whose workspace has left the computer is not offered.
  expect(texts()).toEqual([["claude", "pairfob"], [t("create.terminal"), "site"], [t("rail.createMore"), ""]]);
  expect(rows().every(row => row.getAttribute("role") === "menuitem")).toBe(true);
  const recents = sheet().querySelector(`[role=group][aria-label="${t("create.recent")}"]`)!;
  expect(recents.querySelectorAll("[role=menuitem]")).toHaveLength(2);
  expect(recents.querySelector(".menu-section-title")?.getAttribute("aria-hidden")).toBe("true");
  expect(recents.querySelectorAll(".agent-avatar")).toHaveLength(2);
});

test("the keyboard opens the same menu, and a right-click with an anchor hangs under it too", () => {
  trigger.focus();
  trigger.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  act(() => openQuickCreate(trigger));
  expect(sheet().dataset.popover).toBe("menu");
  expect([sheet().style.left, sheet().style.top]).toEqual(["258px", "50px"]);
  act(() => closeTestDialogs());

  press("mouse", { button: 2, clientX: 280, clientY: 36 });
  act(() => openQuickCreate(trigger));
  expect([sheet().style.left, sheet().style.top]).toEqual(["258px", "50px"]);
  act(() => closeTestDialogs());

  // Without one (the board's "+ tab") a context click opens it at the pointer.
  press("mouse", { button: 2, clientX: 600, clientY: 300 });
  act(() => openQuickCreate());
  expect([sheet().style.left, sheet().style.top]).toEqual(["600px", "300px"]);
});

test("a recent combination creates exactly once, in its workspace, without another question", async () => {
  press("mouse");
  act(() => openQuickCreate(trigger));
  await act(async () => { rows()[0].click(); await pause(10); });
  expect(created).toEqual([{ workspace_id: "w1", agent_kind: "claude" }]);
  expect(document.querySelector("dialog[open]")).toBeNull();
  await act(async () => { await pause(10); });
  expect(created).toHaveLength(1);
});

test("the last row opens the full create sheet as the centred form it is", async () => {
  press("mouse");
  act(() => openQuickCreate(trigger));
  await act(async () => { rows().at(-1)!.click(); await pause(10); });
  const form = document.querySelector<HTMLDialogElement>("dialog.create-sheet")!;
  expect(form.open).toBe(true);
  expect(form.hasAttribute("data-popover")).toBe(false);
  expect(created).toEqual([]);
});

test("a finger on the same wide layout keeps the sheet and its copy", async () => {
  press("touch");
  act(() => openQuickCreate(trigger));
  expect(sheet().className).toBe("modal sheet");
  expect(sheet().hasAttribute("data-popover")).toBe(false);
  expect(sheet().querySelector(".modal-title")?.textContent).toBe(t("create.quickTitle"));
  expect(texts()).toEqual([["claude", "pairfob"], [t("create.terminal"), "site"], [t("create.quickMore"), ""]]);
  expect([...sheet().querySelector(".sheet-body")!.children].map(node => node.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
  expect(sheet().querySelectorAll("[role]")).toHaveLength(0);
  await act(async () => { rows()[1].click(); await pause(10); });
  expect(created).toEqual([{ workspace_id: "w2" }]);
});

test("with nothing recent, or no tab capability, it is the full create sheet", async () => {
  localStorage.removeItem(CREATE_MEMORY_KEY);
  press("mouse");
  await act(async () => { openQuickCreate(trigger); await pause(); });
  expect(document.querySelector("dialog[data-popover]")).toBeNull();
  expect(document.querySelector<HTMLDialogElement>("dialog.create-sheet")?.open).toBe(true);
  await act(async () => { closeTestDialogs(); await pause(); });

  rememberCreate({ kind: "claude", workspaceId: "w1" });
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_conversation: true }, ["claude"]);
  press("mouse");
  await act(async () => { openQuickCreate(trigger); await pause(); });
  expect(document.querySelector("dialog[data-popover]")).toBeNull();
  expect(document.querySelector<HTMLDialogElement>("dialog.create-sheet")?.open).toBe(true);
});
