import { resetBoardTestDOM } from "../../../../test-support/dom";
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
  togglePanePin,
  type TermCols,
  type TermFit,
} from "../../settings/preferences-store";
import { type ListGroup } from "../../../lib/ranking";
import { setPhase } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { setComposeLive } from "../compose-store";
import {
  selectPane,
  setAgentChat,
  setFullTerminal,
  setTermSelect,
} from "../session-store";
import { applyCapabilities, setOperationBusy } from "../../operations/capabilities-store";
import { replaceAgentsFromSnapshot } from "../../dashboard/catalog-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { openPaneMenu } from "./pane-menu";
import { openPaneSwitcher } from "./pane-switcher";

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

test("guided menu shows modes, input/display and this-pane actions with capability-gated sections", () => {
  act(openPaneMenu);
  expect(document.querySelector("h2")?.textContent).toBe(t("pane.menuTitle"));
  expect(radio(TERM_MODE_MENU.guided).getAttribute("aria-checked")).toBe("true");
  expect(radio(TERM_MODE_MENU.agent).disabled).toBeTrue();
  expect(sections()).toContain(t("menu.input"));
  expect(sections()).toContain(t("menu.display"));
  expect(sections()).not.toContain(t("menu.new"));
  expect(sections()).not.toContain(t("menu.worktree"));
  expect(labels()).toContain(t("menu.renamePane"));
  expect(labels()).toContain(t("op.closePane"));
  expect(labels()).not.toContain(t("menu.renameWorkspace"));
  expect(labels()).not.toContain(t("op.closeTab"));
  expect(labels()).not.toContain(t("menu.history"));
});

test("full terminal retains retry and width choices, with no wrap action", () => {
  setFullTerminal(true);
  setPaneTermMode("p1", "full");
  setTermGrid("pan", 120);
  act(openPaneMenu);
  expect(labels()).toContain(t("pane.reconnect"));
  expect(labels()).not.toContain(t("menu.wrap"));
  expect(radio(t("pane.fitAria")).getAttribute("aria-checked")).toBe("false");
  for (const cols of TERM_COL_PRESETS) expect(radio(t("pane.panColsAria", { cols })).getAttribute("aria-checked")).toBe(String(cols === 120));
});

test("agent chat omits terminal input/display while retaining pane operations", () => {
  setAgentChat(true);
  setPaneTermMode("p1", "agent");
  act(openPaneMenu);
  expect(radio(TERM_MODE_MENU.agent).disabled).toBeFalse();
  expect(sections()).not.toContain(t("menu.input"));
  expect(sections()).not.toContain(t("menu.display"));
  expect(labels()).toContain(t("op.closePane"));
});

test("individual capabilities reveal creation, worktree and split-layout actions", () => {
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true, split_pane: true, list_worktrees: true,
    create_worktree: true, open_worktree: true, zoom_pane: true, resize_pane: true, swap_pane: true }, []);
  seedAgents([card("p1"), card("p2")]);
  setTermFontPx(TERM_FONT_MAX);
  act(openPaneMenu);
  for (const label of [t("menu.newTab"), t("menu.split"), t("menu.worktrees"), t("menu.newWorktree"), t("menu.openWorktree"), t("menu.zoom"), t("menu.swap")]) expect(labels()).toContain(label);
  const grow = [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((button) => button.textContent === t("pane.fontUpCurrent", { n: TERM_FONT_MAX }))!;
  expect(grow.disabled).toBeTrue();
});

test("switcher keeps ranked cards, pinned marker, active state and contextual metadata", () => {
  seedAgents([card("p1"), card("p2", { label: "Pinned", status: "working" })]);
  togglePanePin("p2");
  act(openPaneSwitcher);
  const items = [...document.querySelectorAll(".switch-item")];
  expect(items).toHaveLength(2);
  expect(items[0].querySelector(".switch-name")?.textContent).toBe("Pinned");
  expect(items[0].querySelector(".pin-mark")?.getAttribute("aria-hidden")).toBe("true");
  expect(items[1].classList.contains("on")).toBeTrue();
  expect(items[0].querySelector(".switch-meta")?.textContent).toContain(t("status.working"));
});

test("empty switcher retains its explanation and cancel action", () => {
  seedAgents([]);
  act(openPaneSwitcher);
  expect(document.querySelector(".switch-list")?.textContent).toContain(t("home.switcherEmptyTitle"));
  expect(labels()).toContain(t("cancel"));
});