import { resetBoardTestDOM } from "../../../test-support/dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../../test-support/close-dialogs";
import { t, setLang } from "../../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../../lib/operations";
import type { SnapshotWire } from "../../lib/dashboard";
import { applyCapabilities, setOperationBusy } from "../../features/operations/capabilities-store";
import { liveAgents, replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { setScreen } from "../../app/navigation-store";
import { setListGroup, resetHerdPresentationChoices, preferencesStore } from "../../features/settings/preferences-store";
import { selectPane } from "../../features/session/session-store";
import type { DashboardAgentCard } from "../../lib/dashboard";
import { openListPaneMenu, openListWorkspaceMenu } from "./object-menu";

type SeedRow = {
  paneId: string;
  paneLabel?: string;
  agent?: string;
  status: DashboardAgentCard["status"];
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  tabLabel?: string;
  cwd: string;
};

/** Seed the herd through the dashboard owner action, with a real daemon snapshot. */
function seed(rows: SeedRow[]): void {
  const snapshot: SnapshotWire = {
    workspaces: [...new Map(rows.map((row) => [row.workspaceId, row])).values()]
      .map((row) => ({ workspace_id: row.workspaceId, label: row.workspaceLabel, cwd: row.cwd })),
    tabs: [...new Map(rows.map((row) => [row.tabId, row])).values()]
      .map((row) => ({ tab_id: row.tabId, workspace_id: row.workspaceId, label: row.tabLabel ?? "main" })),
    panes: rows.map((row) => ({
      pane_id: row.paneId,
      agent: row.agent ?? "codex",
      agent_status: row.status,
      workspace_id: row.workspaceId,
      tab_id: row.tabId,
      label: row.paneLabel ?? row.paneId,
      cwd: row.cwd,
    })),
  };
  replaceAgentsFromSnapshot(snapshot);
}

/** The live p2 card the menu opens on (carries the snapshot-derived tab label). */
function targetCard(): DashboardAgentCard {
  const card = liveAgents().find((agent) => agent.paneId === "p2");
  if (!card) throw new Error("missing p2 card");
  return card as DashboardAgentCard;
}

const labels = () => [...document.querySelectorAll(".sheet-body button")].map(button => button.textContent);
async function pause(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  setScreen("home");
  resetDashboard();
  resetHerdPresentationChoices();
  setListGroup("flat");
  setOperationBusy(false);
  // The first case pins p2 against the *selected* p1; reset the baseline pane
  // explicitly rather than relying on leftover state.
  selectPane("p1");
  applyCapabilities({ ...NO_OPERATION_CAPABILITIES }, []);
  seed([
    { paneId: "p1", agent: "codex", status: "working", workspaceId: "w1", workspaceLabel: "One", tabId: "t1", cwd: "/one" },
    { paneId: "p2", paneLabel: "Target", agent: "codex", status: "idle", workspaceId: "w2", workspaceLabel: "Two", tabId: "t2", cwd: "/two/project" },
  ]);
});
afterEach(async () => await act(async () => { closeTestDialogs(); await pause(); }));

test("object actions keep full facts above the list and pin the card rather than the selected pane", async () => {
  act(() => openListPaneMenu(targetCard()));
  const body = document.querySelector(".sheet-body")!;
  expect(body.firstElementChild?.className).toBe("sheet-facts");
  expect(body.querySelector(".sheet-fact-path")?.textContent).toContain("/two/project");
  expect(labels()).toContain(t("menu.renamePane"));
  expect(labels()).toContain(t("op.closePane"));
  expect(labels()).not.toContain(t("cancel"));
  await act(async () => {
    [...body.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("menu.pin"))!.click();
    await pause();
  });
  expect(preferencesStore.get().panePinned.p2).toBeGreaterThan(0);
  expect(preferencesStore.get().panePinned.p1).toBeUndefined();
  act(() => openListPaneMenu(targetCard()));
  expect(labels()).toContain(t("menu.unpin"));
});

test("tab rename requires a visible label or split; tab close requires a split", async () => {
  act(() => openListPaneMenu(targetCard()));
  expect(labels()).not.toContain(t("menu.renameTab"));
  expect(labels()).not.toContain(t("op.closeTab"));
  await act(async () => { closeTestDialogs(); await pause(); });
  // Give p2's tab a visible (non-default) label: the card then offers rename.
  seed([
    { paneId: "p1", agent: "codex", status: "working", workspaceId: "w1", workspaceLabel: "One", tabId: "t1", cwd: "/one" },
    { paneId: "p2", paneLabel: "Target", tabLabel: "Review", agent: "codex", status: "idle", workspaceId: "w2", workspaceLabel: "Two", tabId: "t2", cwd: "/two/project" },
  ]);
  act(() => openListPaneMenu(targetCard()));
  expect(labels()).toContain(t("menu.renameTab"));
  expect(labels()).not.toContain(t("op.closeTab"));
  await act(async () => { closeTestDialogs(); await pause(); });
  // A split: two panes (p2 and its copy p3) share the same Review tab.
  seed([
    { paneId: "p1", agent: "codex", status: "working", workspaceId: "w1", workspaceLabel: "One", tabId: "t1", cwd: "/one" },
    { paneId: "p2", paneLabel: "Target", tabLabel: "Review", agent: "codex", status: "idle", workspaceId: "w2", workspaceLabel: "Two", tabId: "t2", cwd: "/two/project" },
    { paneId: "p3", paneLabel: "Target", tabLabel: "Review", agent: "codex", status: "idle", workspaceId: "w2", workspaceLabel: "Two", tabId: "t2", cwd: "/two/project" },
  ]);
  act(() => openListPaneMenu(targetCard()));
  expect(labels()).toContain(t("op.closeTab"));
});

test("workspace grouping moves parent management to the workspace menu", async () => {
  setListGroup("space");
  act(() => openListPaneMenu(targetCard()));
  expect(labels()).not.toContain(t("menu.renameWorkspace"));
  expect(labels()).not.toContain(t("op.closeWorkspace"));
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => openListWorkspaceMenu(targetCard()));
  expect(labels()).toEqual([t("menu.renameWorkspace"), t("op.closeWorkspace")]);
});

test("new-tab capability gates both card and workspace entry without offering split", async () => {
  act(() => applyCapabilities({ ...NO_OPERATION_CAPABILITIES, create_tab: true }, []));
  act(() => openListPaneMenu(targetCard()));
  expect(labels()).toContain(t("menu.newTabBeside"));
  expect(labels()).not.toContain(t("menu.split"));
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => openListWorkspaceMenu(targetCard()));
  expect(labels()[0]).toBe(t("menu.newTabInWorkspace"));
});
