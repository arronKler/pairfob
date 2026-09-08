import { resetBoardTestDOM } from "../../test-support/dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../test-support/close-dialogs";
import { t, setLang } from "../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import { state } from "../state";
import { setRenderer } from "../paint";
import { openListPaneMenu, openListWorkspaceMenu } from "./list-menu";

const card = () => state.agents[1];
const labels = () => [...document.querySelectorAll(".sheet-body button")].map(button => button.textContent);
async function pause(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
}
beforeEach(async () => {
  await resetBoardTestDOM(); setLang("zh"); setRenderer(() => {});
  Object.assign(state, { paneId: "p1", panePinned: {}, paneTouched: {}, listGroup: "flat", operationBusy: false,
    operationCapabilities: { ...NO_OPERATION_CAPABILITIES },
    agents: [
      { paneId: "p1", agent: "codex", status: "working", workspaceId: "w1", workspaceLabel: "One", tabId: "t1", cwd: "/one" },
      { paneId: "p2", paneLabel: "Target", agent: "codex", status: "idle", workspaceId: "w2", workspaceLabel: "Two", tabId: "t2", cwd: "/two/project" },
    ] });
});
afterEach(async () => await act(async () => { closeTestDialogs(); await pause(); }));

test("object actions keep full facts above the list and pin the card rather than the selected pane", async () => {
  act(() => openListPaneMenu(card()));
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
  expect(state.panePinned.p2).toBeGreaterThan(0);
  expect(state.panePinned.p1).toBeUndefined();
  act(() => openListPaneMenu(card()));
  expect(labels()).toContain(t("menu.unpin"));
});

test("tab rename requires a visible label or split; tab close requires a split", async () => {
  act(() => openListPaneMenu(card()));
  expect(labels()).not.toContain(t("menu.renameTab"));
  expect(labels()).not.toContain(t("op.closeTab"));
  await act(async () => { closeTestDialogs(); await pause(); });
  card().tabLabel = "Review";
  act(() => openListPaneMenu(card()));
  expect(labels()).toContain(t("menu.renameTab"));
  expect(labels()).not.toContain(t("op.closeTab"));
  await act(async () => { closeTestDialogs(); await pause(); });
  state.agents.push({ ...card(), paneId: "p3" });
  act(() => openListPaneMenu(card()));
  expect(labels()).toContain(t("op.closeTab"));
});

test("workspace grouping moves parent management to the workspace menu", async () => {
  state.listGroup = "space";
  act(() => openListPaneMenu(card()));
  expect(labels()).not.toContain(t("menu.renameWorkspace"));
  expect(labels()).not.toContain(t("op.closeWorkspace"));
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => openListWorkspaceMenu(card()));
  expect(labels()).toEqual([t("menu.renameWorkspace"), t("op.closeWorkspace")]);
});

test("new-tab capability gates both card and workspace entry without offering split", async () => {
  state.operationCapabilities.create_tab = true;
  act(() => openListPaneMenu(card()));
  expect(labels()).toContain(t("menu.newTabBeside"));
  expect(labels()).not.toContain(t("menu.split"));
  await act(async () => { closeTestDialogs(); await pause(); });
  act(() => openListWorkspaceMenu(card()));
  expect(labels()[0]).toBe(t("menu.newTabInWorkspace"));
});
