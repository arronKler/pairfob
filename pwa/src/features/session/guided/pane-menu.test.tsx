import { expectSameNode, expectSameNodes } from "../../../../test-support/node-identity";
import { happy, resetBoardTestDOM } from "../../../../test-support/dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../../../test-support/close-dialogs";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { setLang, t } from "../../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../../lib/operations";
import { TERM_MODE_MENU } from "../../../lib/ui-model";
import {
  LIST_GROUP_KEY,
  TERM_COL_PRESETS,
  TERM_COLS_KEY,
  TERM_FIT_KEY,
  TERM_FONT_MAX,
  TERM_WRAP_KEY,
  listGroup,
  listGroupCollapsed,
  resetHerdPresentationChoices,
  setListGroup,
  setListGroupCollapsed,
  setPaneTermMode,
  setTermGrid,
  setTermWrap,
  setTermFontPx,
  termCols,
  termFit,
  termWrap,
  type TermCols,
  type TermFit,
} from "../../settings/preferences-store";
import { type ListGroup } from "../../../lib/ranking";
import { setNetworkOnline, setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { setComposeLive } from "../compose-store";
import {
  applyPaneRead,
  selectPane,
  setAgentChat,
  setFullTerminal,
  setTermSelect,
} from "../session-store";
import { applyCapabilities, setOperationBusy } from "../../operations/capabilities-store";
import { dashboardStore, replaceAgentsFromSnapshot } from "../../dashboard/catalog-store";
import { projectSnapshot } from "../../board/layout-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { openPaneMenu } from "./pane-menu";
import { ProtocolError } from "../../../lib/protocol/errors";
import { bindOverlayOrigin } from "../../../shared/ui/overlay/origin";
import { tabStops } from "../../../shared/ui/overlay/tab-stops";

const labels = () => [...document.querySelectorAll(".sheet-body button")].map((button) => button.textContent);
const sections = () => [...document.querySelectorAll(".menu-section-title")].map((node) => node.textContent);
const radio = (aria: string) => document.querySelector<HTMLButtonElement>(`[role=radio][aria-label="${aria}"]`)!;

function card(paneId: string, patch: { label?: string; status?: DashboardAgentStatus } = {}): Record<string, string> {
  return {
    pane_id: paneId, workspace_id: "w1", tab_id: "t1", cwd: "/one",
    agent: "codex", agent_status: patch.status ?? "idle", label: patch.label ?? "First",
  };
}
type DashboardAgentStatus = "idle" | "working" | "done" | "blocked" | "unknown";
function seedAgents(panes: Array<Record<string, string>>): void {
  replaceAgentsFromSnapshot({
    workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }],
    tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
    panes,
  });
}

// The pane-map seed re-projects the dashboard and prunes daemon-scoped pane
// preferences/pins (writing raw storage preimages); capture the foreign
// canonical maps/raw BEFORE any seed and restore AFTER own teardown so foreign
// domains/subscribers survive. Reset is narrow (named owners), never a global
// store reset or storage.clear.
const foreign = new WorkspaceSnapshotRestorer();

// The WorkspaceSnapshotRestorer intentionally does not cover the non-scoped
// scalar preferences this fixture's named setters persist (listGroup, termFit,
// termCols, termWrap), nor the in-memory fold that resetHerdPresentationChoices
// clears. Capture their canonical + exact raw preimages (strings or null) once
// per case BEFORE any seed/canonical write, and restore after own teardown with
// the raw preimages written LAST, so foreign scalar/fold values survive.
let preListGroup: ListGroup = "flat";
let preListGroupRaw: string | null = null;
let preTermFit: TermFit = "fit";
let preTermFitRaw: string | null = null;
let preTermCols: TermCols = 80;
let preTermColsRaw: string | null = null;
let preTermWrap = false;
let preTermWrapRaw: string | null = null;
let preCollapsed: Record<string, boolean> = {};
let scalarsCaptured = false;
function captureScalars(): void {
  if (scalarsCaptured) return;
  scalarsCaptured = true;
  preListGroup = listGroup();
  preListGroupRaw = localStorage.getItem(LIST_GROUP_KEY);
  preTermFit = termFit();
  preTermFitRaw = localStorage.getItem(TERM_FIT_KEY);
  preTermCols = termCols();
  preTermColsRaw = localStorage.getItem(TERM_COLS_KEY);
  preTermWrap = termWrap();
  preTermWrapRaw = localStorage.getItem(TERM_WRAP_KEY);
  preCollapsed = listGroupCollapsed();
}
function restoreScalars(): void {
  if (!scalarsCaptured) return;
  setListGroup(preListGroup);
  setTermGrid(preTermFit, preTermCols);
  setTermWrap(preTermWrap);
  setListGroupCollapsed(preCollapsed);
  // Exact raw preimages (strings or null) go LAST, after the canonical setters.
  if (preListGroupRaw === null) localStorage.removeItem(LIST_GROUP_KEY);
  else localStorage.setItem(LIST_GROUP_KEY, preListGroupRaw);
  if (preTermFitRaw === null) localStorage.removeItem(TERM_FIT_KEY);
  else localStorage.setItem(TERM_FIT_KEY, preTermFitRaw);
  if (preTermColsRaw === null) localStorage.removeItem(TERM_COLS_KEY);
  else localStorage.setItem(TERM_COLS_KEY, preTermColsRaw);
  if (preTermWrapRaw === null) localStorage.removeItem(TERM_WRAP_KEY);
  else localStorage.setItem(TERM_WRAP_KEY, preTermWrapRaw);
  scalarsCaptured = false;
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  foreign.capture();
  captureScalars();
  setPhase("live");
  setScreen("pane");
  selectPane("p1");
  resetHerdPresentationChoices();
  setListGroup("flat");
  setFullTerminal(false);
  setAgentChat(false);
  setComposeLive(false);
  setTermWrap(false);
  setTermSelect(false);
  setPaneTermMode("p1", "guided");
  setOperationBusy(false);
  setTermGrid("fit", 120);
  setTermFontPx(14);
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  attachLiveSession({ isConnected: () => true } as never);
  seedAgents([card("p1")]);
});
afterEach(async () => await act(async () => {
  closeTestDialogs();
  await new Promise((resolve) => setTimeout(resolve, 10));
  foreign.restore();
  restoreScalars();
}));

const quick = () => document.querySelector(".pane-quick")!;
const rows = () => [...document.querySelectorAll(".sheet-body .menu-row")].map((row) => row.textContent);
const tiles = () => [...document.querySelectorAll(".sheet-body .menu-tile")].map((tile) => tile.getAttribute("aria-label"));
const sheetOpen = () => document.querySelector<HTMLDialogElement>("dialog.sheet")?.open === true;
const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`.sheet-body button[aria-label="${label}"]`)!;

test("the root names the pane, explains the mode, and ends with an inline close", () => {
  act(openPaneMenu);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  expect(dialog.querySelector("h2")?.textContent).toBe(t("pane.menuTitle"));
  expect(dialog.classList.contains("is-expandable")).toBeFalse();
  expect(dialog.querySelector(".pane-head b")?.textContent).toBe("First");
  expect(byLabel(t("pm.copyPathAria", { path: "/one" }))).not.toBeNull();
  expect(radio(TERM_MODE_MENU.guided).getAttribute("aria-checked")).toBe("true");
  expect(radio(TERM_MODE_MENU.agent).disabled).toBeTrue();
  expect(dialog.querySelector(".pane-mode-hint")?.textContent).toContain(t("pm.modeAgentOff"));
  expect(quick().textContent).toContain(t("menu.input"));
  expect(quick().querySelector(".menu-stepper-value")?.textContent).toBe(t("pane.fontPx", { n: 14 }));
  expect(quick().querySelector("[role=switch]")?.getAttribute("aria-label")).toBe(t("menu.wrap"));
  expect(tiles()).toEqual([t("menu.copyScreen"), t("menu.renamePane")]);
  expect(rows().some((row) => row?.startsWith(t("pm.layout")))).toBeTrue();
  expect(rows()).not.toContain(t("menu.worktree"));
  expect(document.querySelector(".menu-danger-zone")?.textContent).toBe(t("pm.closePane"));
  expect(labels()).not.toContain(t("cancel"));
});

test("closing confirms inside the sheet, warns while running, and then closes the pane", async () => {
  seedAgents([card("p1", { status: "working" })]);
  const closed: string[] = [];
  attachLiveSession({ isConnected: () => true, closePane: async (paneId: string) => { closed.push(paneId); throw new Error("stop"); } } as never);
  act(openPaneMenu);
  const zone = () => document.querySelector(".menu-danger-zone")!;
  const scrolled: Element[] = [];
  const view = document.defaultView!;
  const realScroll = view.Element.prototype.scrollIntoView;
  view.Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  try {
    act(() => zone().querySelector<HTMLButtonElement>(".menu-row")!.click());
  } finally {
    view.Element.prototype.scrollIntoView = realScroll;
  }
  // The question opens at the foot of a tall sheet; it is brought on screen.
  expectSameNodes(scrolled, [zone().querySelector(".pane-confirm")!]);
  expect(sheetOpen()).toBeTrue();
  expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
  expect(zone().querySelector(".pane-confirm-subject")?.textContent).toContain("First");
  expect(zone().querySelector(".pane-confirm-warn")?.textContent).toBe(t("confirm.closeRunning"));
  const [cancel, confirm] = [...zone().querySelectorAll<HTMLButtonElement>(".pane-confirm-actions button")];
  // As the confirmation dialog: Cancel first and holding focus, the destructive answer after it.
  expect([cancel.textContent, confirm.textContent]).toEqual([t("cancel"), t("pm.closePane")]);
  expectSameNode(document.activeElement, cancel);
  act(() => cancel.click());
  expect(zone().querySelector(".pane-confirm")).toBeNull();
  // Cancel gives focus back to the row that asked.
  expectSameNode(document.activeElement, zone().querySelector(".menu-row"));
  act(() => zone().querySelector<HTMLButtonElement>(".menu-row")!.click());
  await act(async () => { zone().querySelectorAll<HTMLButtonElement>(".pane-confirm-actions button")[1].click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(confirm).toBeDefined();
  expect(sheetOpen()).toBeFalse();
  expect(closed).toEqual(["p1"]);
});

test("copy screen reports the line count and keeps the sheet open", async () => {
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  try {
    act(() => applyPaneRead("\x1b[31mone\x1b[0m\ntwo\n\n", "h-copy"));
    act(openPaneMenu);
    await act(async () => { byLabel(t("menu.copyScreen")).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(written).toEqual(["one\ntwo"]);
    expect(document.querySelector(".pane-menu-status")?.textContent).toBe(t("pm.copiedLines", { n: "2" }));
    expect(sheetOpen()).toBeTrue();
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

test("text size, wrap and input apply in place and keep the sheet open", async () => {
  act(openPaneMenu);
  act(() => byLabel(t("menu.fontUp")).click());
  expect(sheetOpen()).toBeTrue();
  expect(quick().querySelector(".menu-stepper-value")?.textContent).toBe(t("pane.fontPx", { n: 15 }));
  act(() => quick().querySelector<HTMLButtonElement>("[role=switch]")!.click());
  expect(sheetOpen()).toBeTrue();
  expect(termWrap()).toBeTrue();
  expect(quick().querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
  setTermFontPx(TERM_FONT_MAX);
  act(() => { closeTestDialogs(); });
  act(openPaneMenu);
  expect(byLabel(t("menu.fontUp")).disabled).toBeTrue();
});

test("full terminal keeps reconnect and applies width in place, with no wrap switch", () => {
  setFullTerminal(true);
  setPaneTermMode("p1", "full");
  setTermGrid("fit", 120);
  act(openPaneMenu);
  expect(rows()).toContain(t("pane.reconnect"));
  expect(quick().querySelector("[role=switch]")).toBeNull();
  expect(radio(t("pane.fitAria")).getAttribute("aria-checked")).toBe("true");
  act(() => radio(t("pane.panColsAria", { cols: 100 })).click());
  expect(sheetOpen()).toBeTrue();
  expect(termFit()).toBe("pan");
  expect(termCols()).toBe(100);
  for (const cols of TERM_COL_PRESETS) expect(radio(t("pane.panColsAria", { cols })).getAttribute("aria-checked")).toBe(String(cols === 100));
});

test("agent chat omits terminal settings and screen actions while retaining pane operations", () => {
  setAgentChat(true);
  setPaneTermMode("p1", "agent");
  act(openPaneMenu);
  expect(radio(TERM_MODE_MENU.agent).disabled).toBeFalse();
  expect(document.querySelector(".pane-quick")).toBeNull();
  expect(tiles()).toEqual([t("menu.renamePane")]);
  expect(document.querySelector(".menu-danger-zone")?.textContent).toBe(t("pm.closePane"));
});

const pageRow = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".sheet-body .menu-row")]
  .find((row) => row.querySelector(".menu-row-label")?.textContent === label)!;

test("new tab reuses the create grid, fixes the workspace, and keeps a failure on the page", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, ["codex", "claude"]);
  const calls: Array<Record<string, unknown>> = [];
  attachLiveSession({ isConnected: () => true, createTab: async (input: Record<string, unknown>) => {
    calls.push(input); throw new ProtocolError("invalid_argument", "no such kind");
  } } as never);
  act(openPaneMenu);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  act(() => byLabel(t("menu.newTab")).click());
  expect(dialog.querySelector("h2")?.textContent).toBe(t("pm.newTabTitle"));
  expect(dialog.querySelector(".sheet-back-label")?.textContent).toBe(t("pane.menuTitle"));
  expect(dialog.querySelector(".pane-where b")?.textContent).toBe("One");
  expect([...dialog.querySelectorAll(".create-kind-name")].map((node) => node.textContent)).toEqual(["codex", "claude", t("create.terminal")]);
  act(() => [...dialog.querySelectorAll<HTMLButtonElement>(".create-kind")].find((node) => node.textContent?.includes("claude"))!.click());
  expect(dialog.querySelector(".create-summary")?.textContent).toBe(t("create.summaryTab", { workspace: "One", kind: "claude" }));
  await act(async () => { dialog.querySelector<HTMLButtonElement>(".pane-page-footer .create-submit")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(calls).toEqual([{ workspace_id: "w1", agent_kind: "claude" }]);
  expect(sheetOpen()).toBeTrue();
  expect(dialog.querySelector(".pane-page-note.is-error")?.textContent).toBeTruthy();
  act(() => dialog.querySelector<HTMLButtonElement>(".sheet-back")!.click());
  expect(dialog.querySelector(".pane-head")).not.toBeNull();
});

test("offline pages say why and keep the primary action off", () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, ["codex"]);
  act(openPaneMenu);
  act(() => byLabel(t("menu.newTab")).click());
  act(() => setNetworkOnline(false));
  try {
    expect(document.querySelector<HTMLButtonElement>(".pane-page-footer .create-submit")!.disabled).toBeTrue();
    expect(document.querySelector(".pane-page-footer .pane-page-note")?.textContent).toBe(t("boardMenu.offline"));
  } finally { act(() => setNetworkOnline(true)); }
});

test("split picks its side on the preview and sends one split with the chosen kind", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, split_pane: true }, ["codex"]);
  const calls: Array<Record<string, unknown>> = [];
  attachLiveSession({ isConnected: () => true, splitPane: async (input: Record<string, unknown>) => { calls.push(input); throw new Error("stop"); } } as never);
  act(openPaneMenu);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  act(() => byLabel(t("menu.split")).click());
  expect(dialog.querySelector("h2")?.textContent).toBe(t("pm.splitTitle"));
  expect(dialog.querySelector(".pane-layout-cell.is-new")).not.toBeNull();
  expect(dialog.querySelector(".create-summary")?.textContent).toBe(t("pm.splitSummaryRight", { kind: "codex" }));
  act(() => byLabel(t("pm.splitDownAria")).click());
  expect(byLabel(t("pm.splitDownAria")).getAttribute("aria-checked")).toBe("true");
  expect(dialog.querySelector(".create-summary")?.textContent).toBe(t("pm.splitSummaryDown", { kind: "codex" }));
  await act(async () => { dialog.querySelector<HTMLButtonElement>(".pane-page-footer .create-submit")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(calls).toEqual([{ pane_id: "p1", direction: "down", ratio: 0.5, agent_kind: "codex" }]);
});

test("rename edits in place: prefilled, clearable, Enter saves and blank restores the automatic name", async () => {
  const calls: Array<[string, string | null]> = [];
  attachLiveSession({ isConnected: () => true, renamePane: async (paneId: string, label: string | null) => { calls.push([paneId, label]); },
    snapshot: async () => ({ workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [card("p1")] }) } as never);
  act(openPaneMenu);
  act(() => byLabel(t("menu.renamePane")).click());
  const input = document.querySelector<HTMLInputElement>(".pane-rename input")!;
  expect(input.value).toBe("First");
  expect(document.querySelector(".pane-rename + .create-hint")?.textContent).toContain(t("pm.renameHint", { name: "" }).trim());
  act(() => byLabel(t("pm.renameClear")).click());
  expect(input.value).toBe("");
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(calls).toEqual([["p1", null]]);
  expect(sheetOpen()).toBeFalse();
});

test("Worktree lists in place, marks the current checkout, and opens a row with its own spinner", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, list_worktrees: true, create_worktree: true, open_worktree: true }, ["codex"]);
  let release!: () => void;
  const opened: Array<Record<string, unknown>> = [];
  attachLiveSession({ isConnected: () => true,
    listWorktrees: () => new Promise((resolve) => { release = () => resolve({ worktrees: [
      { path: "/one", branch: "main", label: null, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: false, open_workspace_id: "w1" },
      { path: "/one-wt/keys", branch: "feat/keys", label: null, is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: null },
    ] }); }),
    openWorktree: async (input: Record<string, unknown>) => { opened.push(input); throw new Error("stop"); } } as never);
  act(openPaneMenu);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  act(() => pageRow(t("menu.worktree")).click());
  expect(dialog.querySelectorAll(".pane-wt.is-skeleton")).toHaveLength(3);
  await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  const rowsNow = [...dialog.querySelectorAll(".pane-wt-list > li")];
  expect(rowsNow.map((row) => row.querySelector("b")?.textContent)).toEqual(["main", "feat/keys"]);
  expect(rowsNow[0].querySelector(".pane-wt-tag")?.textContent).toBe(t("pm.wtCurrent"));
  expect(rowsNow[0].querySelector("button")).toBeNull();
  await act(async () => { rowsNow[1].querySelector<HTMLButtonElement>("button")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(opened).toEqual([{ workspace_id: "w1", path: "/one-wt/keys" }]);
  expect(sheetOpen()).toBeTrue();
  act(() => pageRow(t("pm.wtNew")).click());
  expect(dialog.querySelector("h2")?.textContent).toBe(t("pm.wtNew"));
  expect(dialog.querySelector(".sheet-back-label")?.textContent).toBe(t("menu.worktree"));
  act(() => dialog.querySelector<HTMLButtonElement>(".sheet-back")!.click());
  act(() => pageRow(t("pm.wtOpenBy")).click());
  expect(dialog.querySelectorAll(".create-seg [role=radio]")).toHaveLength(2);
  expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
});

/** Escape as a keyboard sends it: down on what has focus, then up. */
function escape(): void {
  const target = document.activeElement ?? document.body;
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event); });
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keyup", { key: "Escape", bubbles: true }) as unknown as Event); });
}

test("Escape takes back the closing question first, as Cancel does, and only then the panel", async () => {
  act(openPaneMenu);
  const zone = () => document.querySelector(".menu-danger-zone")!;
  act(() => zone().querySelector<HTMLButtonElement>(".menu-row")!.click());
  expectSameNode(document.activeElement, zone().querySelector(".pane-confirm-cancel"));
  escape();
  expect(zone().querySelector(".pane-confirm")).toBeNull();
  expect(sheetOpen()).toBeTrue();
  expectSameNode(document.activeElement, zone().querySelector(".menu-row"));
  escape();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(sheetOpen()).toBeFalse();
});

test("Escape in the full agent list returns to the form it stands in for, then steps back the page", () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, ["codex", "claude", "grok", "pi", "cursor", "hermes", "opencode"]);
  act(openPaneMenu);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  act(() => byLabel(t("menu.newTab")).click());
  act(() => dialog.querySelector<HTMLButtonElement>(".create-kind.is-all")!.click());
  expect(dialog.querySelector(".kind-picker")).not.toBeNull();
  dialog.querySelector<HTMLButtonElement>(".kind-pick")!.focus();
  escape();
  expect(dialog.querySelector(".kind-picker")).toBeNull();
  expect(dialog.querySelector("h2")?.textContent).toBe(t("pm.newTabTitle"));
  dialog.querySelector<HTMLButtonElement>(".create-kind")!.focus();
  escape();
  expect(dialog.querySelector(".pane-head")).not.toBeNull();
  expect(sheetOpen()).toBeTrue();
});

test("the panel's Worktree pages are the shared forms: refused in the field, and never dropping the keyboard while one runs", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_worktree: true, open_worktree: true }, ["codex"]);
  const made: Array<Record<string, unknown>> = [];
  let finish!: (result: unknown) => void;
  attachLiveSession({ isConnected: () => true,
    snapshot: async () => ({ workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }], panes: [card("p1")] }),
    paneRead: async () => ({ text: "", hash: "h" }),
    createWorktree: (input: Record<string, unknown>) => { made.push(input); return new Promise((resolve) => { finish = resolve; }); } } as never);
  act(openPaneMenu);
  const dialog = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  act(() => pageRow(t("menu.worktree")).click());
  act(() => pageRow(t("pm.wtOpenBy")).click());
  expect(dialog.querySelector("h2")?.textContent).toBe(t("menu.openWorktree"));
  const target = dialog.querySelector<HTMLInputElement>('input[name="target"]')!;
  target.focus();
  act(() => { target.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event); });
  expect(dialog.querySelector(".pane-page-note.is-error")?.textContent).toBe(t("form.needPathOrBranch"));
  expect(target.getAttribute("aria-invalid")).toBe("true");
  expectSameNode(document.activeElement, target);
  expect(dialog.querySelector<HTMLFieldSetElement>(".pane-fieldset")!.disabled).toBeFalse();

  act(() => dialog.querySelector<HTMLButtonElement>(".sheet-back")!.click());
  act(() => pageRow(t("pm.wtNew")).click());
  expect([...dialog.querySelectorAll("input")].map((input) => input.name)).toEqual(["branch", "base", "label", "path"]);
  const branch = dialog.querySelector<HTMLInputElement>('input[name="branch"]')!;
  branch.focus();
  await act(async () => {
    branch.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(made).toEqual([{ workspace_id: "w1" }]);
  const primary = dialog.querySelector<HTMLButtonElement>(".pane-page-footer .create-submit")!;
  expect(primary.textContent).toBe(t("pm.wtCreateStarted"));
  expect(primary.disabled).toBeFalse();
  expect(primary.getAttribute("aria-disabled")).toBe("true");
  expectSameNode(document.activeElement, primary);
  // The Worktree exists: the panel closes on it instead of going on saying it is being made.
  await act(async () => { finish({ pane_id: "p1" }); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(sheetOpen()).toBeFalse();
});

test("layout page previews the tab and keeps the daemon edge directions for each step", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, resize_pane: true, swap_pane: true, zoom_pane: true }, []);
  const panes = [card("p1"), card("p2", { label: "Second" })];
  seedAgents(panes);
  projectSnapshot({ workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
    panes, layouts: [{ workspace_id: "w1", tab_id: "t1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
      panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } },
        { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }] }] } as never, dashboardStore.get().agents as never);
  const calls: Array<Record<string, unknown>> = [];
  attachLiveSession({ isConnected: () => true, resizePane: async (input: Record<string, unknown>) => { calls.push(input); throw new Error("stop"); },
    swapPane: async (input: Record<string, unknown>) => { calls.push(input); throw new Error("stop"); } } as never);
  act(openPaneMenu);
  expect(pageRow(t("pm.layout")).querySelector(".pane-row-value")?.textContent).toBe(t("pm.layoutCells", { n: "2" }));
  act(() => pageRow(t("pm.layout")).click());
  expect([...document.querySelectorAll(".pane-layout-cell")].map((cell) => cell.textContent)).toEqual([t("pane.thisCell"), "Second"]);
  expect(byLabel(t("board.paneAria", { title: "Second" }))).not.toBeNull();
  const divider = document.querySelector<HTMLElement>(".pane-divider.is-v")!;
  expect(divider.getAttribute("aria-valuenow")).toBe("50");
  await act(async () => { divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  // herdr's own step: a split's ratio moves 0.05 (board/model/divider.ts covers every side).
  expect(calls.at(-1)).toMatchObject({ pane_id: "p1", direction: "right", amount: 0.05 });
  expect(document.querySelector(".pane-precise .pane-layout-resize .menu-stepper-value")?.textContent).toBe(t("layout.share", { n: 50 }));
  expect(byLabel(t("form.swapLeft")).disabled).toBeTrue();
  // Moving the divider left names the pane whose left edge it is, so herdr can
  // never fall back to another split.
  for (const [label, pane_id, direction] of [["form.wider", "p1", "right"], ["form.narrower", "p2", "left"]] as const) {
    await act(async () => { byLabel(t(label)).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls.at(-1)).toMatchObject({ pane_id, direction, amount: 0.05 });
  }
  await act(async () => { byLabel(t("form.swapRight")).click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(calls.at(-1)).toMatchObject({ pane_id: "p1", direction: "right" });
  expect(sheetOpen()).toBeTrue();
  act(() => setNetworkOnline(false));
  try {
    expect(byLabel(t("form.wider")).disabled).toBeTrue();
    expect(document.querySelector(".pane-layout-status")?.textContent).toBe(t("boardMenu.offline"));
  } finally { act(() => setNetworkOnline(true)); }
});

test("layout page draws every herdr divider like the board and moves a neighbour's split the herdr way", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, resize_pane: true, swap_pane: true }, []);
  const panes = [card("p1"), card("p2", { label: "Review", status: "blocked" }), card("p3", { label: "Dev" })];
  seedAgents(panes);
  // p1 | p2 over p3, in herdr's own shape: the right column's split is not p1's.
  projectSnapshot({ workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
    panes, layouts: [{ workspace_id: "w1", tab_id: "t1", zoomed: false, focused_pane_id: "p2", area: { x: 0, y: 0, width: 200, height: 80 },
      panes: [{ pane_id: "p1", focused: false, rect: { x: 0, y: 0, width: 100, height: 80 } },
        { pane_id: "p2", focused: true, rect: { x: 100, y: 0, width: 100, height: 40 } },
        { pane_id: "p3", focused: false, rect: { x: 100, y: 40, width: 100, height: 40 } }],
      splits: [{ id: "split_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 200, height: 80 } },
        { id: "split_1", direction: "down", ratio: 0.5, rect: { x: 100, y: 0, width: 100, height: 80 } }] }] } as never,
  dashboardStore.get().agents as never);
  const calls: Array<Record<string, unknown>> = [];
  attachLiveSession({ isConnected: () => true, resizePane: async (input: Record<string, unknown>) => { calls.push(input); throw new Error("stop"); } } as never);
  act(openPaneMenu);
  act(() => pageRow(t("pm.layout")).click());
  const preview = document.querySelector<HTMLElement>(".pane-layout-preview")!;
  preview.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 80, right: 200, bottom: 80, x: 0, y: 0, toJSON() {} }) as DOMRect;
  expect([...document.querySelectorAll(".pane-divider")].map(node => node.getAttribute("data-split-id"))).toEqual(["split_root", "split_1"]);
  expect(document.querySelector(".pane-layout-cell.is-blocked")?.textContent).toBe("Review");
  expect(document.querySelector(".pane-layout-cell.is-focused")?.textContent).toBe("Review");
  const inner = document.querySelector<HTMLElement>('.pane-divider[data-split-id="split_1"]')!;
  expect(inner.getAttribute("aria-valuetext")).toBe(t("boardCanvas.dragRows", { first: "40", second: "40", share: "50" }));
  const pointer = (type: string, clientY: number) => new PointerEvent(type, { bubbles: true, pointerId: 7, button: 0, clientX: 150, clientY });
  // Pressing a hair below the line must not jump it (herdr's grab offset).
  act(() => { inner.dispatchEvent(pointer("pointerdown", 41)); });
  expect(document.querySelector(".pane-layout-bubble")?.textContent).toBe(t("boardCanvas.dragRows", { first: "40", second: "40", share: "50" }));
  act(() => { inner.dispatchEvent(pointer("pointermove", 31)); });
  expect(document.querySelector(".pane-layout-bubble")?.textContent).toBe(t("boardCanvas.dragRows", { first: "30", second: "50", share: "38" }));
  await act(async () => { inner.dispatchEvent(pointer("pointerup", 31)); await new Promise((resolve) => setTimeout(resolve, 0)); });
  // Moving the line up names the pane whose top edge it is, so herdr cannot pick another split.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ pane_id: "p3", direction: "up" });
  expect(calls[0].amount as number).toBeCloseTo(0.125, 9);
  expect(document.querySelector(".pane-layout-bubble")).toBeNull();
  // The request failed: once it settled nothing is left drawn as in flight.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.querySelector(".pane-divider.is-pending")).toBeNull();
  // Offline arrives mid-drag: the release sends nothing and leaves no picture of a resize.
  const again = () => document.querySelector<HTMLElement>('.pane-divider[data-split-id="split_1"]')!;
  act(() => { again().dispatchEvent(pointer("pointerdown", 40)); });
  act(() => { again().dispatchEvent(pointer("pointermove", 30)); });
  act(() => setNetworkOnline(false));
  try {
    await act(async () => { again().dispatchEvent(pointer("pointerup", 30)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls).toHaveLength(1);
    expect(document.querySelector(".pane-divider.is-pending, .pane-divider.is-active")).toBeNull();
  } finally { act(() => setNetworkOnline(true)); }
});

test("a single-cell tab shows the preview and says so", () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, resize_pane: true }, []);
  projectSnapshot({ workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
    panes: [card("p1")], layouts: [{ workspace_id: "w1", tab_id: "t1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
      panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 100, height: 40 } }] }] } as never, dashboardStore.get().agents as never);
  act(openPaneMenu);
  act(() => pageRow(t("pm.layout")).click());
  expect(document.querySelector(".pane-layout-single")?.textContent).toBe(t("pm.single"));
  expect(document.querySelector(".pane-divider")).toBeNull();
  expect(document.querySelector(".pane-precise")).toBeNull();
});

for (const scenario of ["empty", "full-unready", "changed", "denied"] as const) {
  test(`copy text handles ${scenario} without a false success`, async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        if (scenario === "denied") throw new Error("permission denied");
        written.push(text);
      },
    } });
    try {
      act(() => applyPaneRead(scenario === "empty" ? " \n\n" : "old guided text", "copy-state"));
      if (scenario === "full-unready") setFullTerminal(true);
      act(openPaneMenu);
      expect(document.querySelector(".pane-menu-status")?.textContent).toBe(t("pm.copyHint"));
      expect(byLabel(t("menu.copyScreen")).textContent).toBe(t("pm.tileCopy"));
      if (scenario === "changed") act(() => selectPane("p2"));
      await act(async () => { byLabel(t("menu.copyScreen")).click(); });
      expect(written).toEqual([]);
      const key = scenario === "denied" ? "err.copyDenied" : scenario === "changed" ? "pm.copyChanged" : "pm.copyEmpty";
      expect(document.querySelector(".pane-menu-status")?.textContent).toBe(t(key));
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
}

test("a mouse on a desk layout gets the same panel under the more button; a finger keeps the sheet", () => {
  const more = document.createElement("button");
  more.className = "icon-btn icon-more";
  more.getBoundingClientRect = () => ({ left: 1390, top: 4, right: 1434, bottom: 48, width: 44, height: 44, x: 1390, y: 4, toJSON() {} });
  document.body.append(more);
  const press = (pointerType: string) => more.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType }) as unknown as Event);
  const content = () => [...document.querySelectorAll(".sheet-body .pane-menu-root > *")].map((node) => node.className);
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  const release = bindOverlayOrigin(document);
  try {
    press("touch");
    act(openPaneMenu);
    const sheet = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
    expect(sheet.className).toBe("modal sheet pane-menu-sheet");
    expect(sheet.style.top).toBe("");
    const asSheet = content();
    act(() => closeTestDialogs());

    press("mouse");
    act(openPaneMenu);
    const panel = document.querySelector<HTMLDialogElement>("dialog.sheet")!;
    expect(panel.className).toBe("modal sheet popover popover-panel pane-menu-sheet");
    // Under the button, on its trailing edge (the test realm lays the panel out 0px wide).
    expect(panel.style.top).toBe("54px");
    expect(panel.style.left).toBe("1432px");
    expect(panel.style.maxHeight).toBe("838px");
    // Nothing is removed or reordered, and its controls keep their own roles.
    expect(content()).toEqual(asSheet);
    expect(panel.querySelector("[role=menu], [role=menuitem]")).toBeNull();
    expect(document.querySelector(".menu-danger-zone")?.textContent).toBe(t("pm.closePane"));
  } finally {
    release();
    more.remove();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});

test("the panel's pages take the desk form: the same name as the rail's dialog, a labelled field, Cancel that steps back", async () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, split_pane: true }, ["codex"]);
  const splits: Array<Record<string, unknown>> = [];
  attachLiveSession({ isConnected: () => true, splitPane: async (input: Record<string, unknown>) => { splits.push(input); return {}; },
    snapshot: async () => ({ workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
      panes: [card("p1")] }) } as never);
  const more = document.createElement("button");
  more.className = "icon-btn icon-more";
  document.body.append(more);
  const press = (pointerType: string) => more.dispatchEvent(new happy.PointerEvent("pointerdown", { bubbles: true, pointerType }) as unknown as Event);
  const panel = () => document.querySelector<HTMLDialogElement>("dialog.sheet")!;
  const stops = () => tabStops(panel()).map((stop) => stop.getAttribute("aria-label") ?? stop.textContent);
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  const release = bindOverlayOrigin(document);
  try {
    press("mouse");
    act(openPaneMenu);
    // The panel starts on its first control proper, the chosen mode, and ends on the dialog's own close.
    expectSameNode(document.activeElement, radio(TERM_MODE_MENU.guided));
    expectSameNode(panel().querySelector("form")!.lastElementChild, panel().querySelector(".desk-close"));
    expect(stops().at(-1)).toBe(t("close"));

    act(() => byLabel(t("menu.renamePane")).click());
    expect(panel().querySelector("h2")?.textContent).toBe(t("menu.renamePane"));
    const input = panel().querySelector<HTMLInputElement>(".pane-rename input")!;
    expect(panel().querySelector(`label[for="${input.id}"]`)?.textContent).toBe(t("op.paneName"));
    expectSameNode(document.activeElement, input);
    // The way back, the field (named by its label), its clear, the footer, the close.
    expect(stops()).toEqual([t("sheet.back"), "", t("pm.renameClear"), t("cancel"), t("pm.save"), t("close")]);
    act(() => panel().querySelector<HTMLButtonElement>(".desk-cancel")!.click());
    expect(panel().open).toBeTrue();
    expect(panel().querySelector("h2")?.textContent).toBe(t("pane.menuTitle"));

    // Enter on a choice chooses it and submits the page.
    act(() => byLabel(t("menu.split")).click());
    const down = panel().querySelector<HTMLButtonElement>(`[role=radio][aria-label="${t("pm.splitDownAria")}"]`)!;
    await act(async () => {
      down.dispatchEvent(new happy.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(splits).toEqual([{ pane_id: "p1", direction: "down", ratio: 0.5, agent_kind: "codex" }]);
    act(() => closeTestDialogs());
    selectPane("p1");

    // The sheet keeps its drill-down: the field named for assistive tech only, no Cancel beside the one button.
    press("touch");
    act(openPaneMenu);
    act(() => byLabel(t("menu.renamePane")).click());
    expect(panel().querySelector("h2")?.textContent).toBe(t("menu.renamePane"));
    expect(panel().querySelector(".pane-rename input")?.getAttribute("aria-label")).toBe(t("op.paneName"));
    expect(panel().querySelector(".pane-rename-label, .desk-cancel, .desk-close")).toBeNull();
  } finally {
    release();
    more.remove();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});
