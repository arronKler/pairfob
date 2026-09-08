import { resetBoardTestDOM } from "../../test-support/dom";
import { beforeEach, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { closeTestDialogs } from "../../test-support/close-dialogs";
import { setLang, t } from "../lib/i18n";
import { NO_OPERATION_CAPABILITIES } from "../lib/operations";
import { TERM_MODE_MENU } from "../lib/ui-model";
import { state, TERM_COL_PRESETS, TERM_FONT_MAX } from "../state";
import { setRenderer } from "../paint";
import { openPaneMenu, openPaneSwitcher } from "./pane-menu";

const labels = () => [...document.querySelectorAll(".sheet-body button")].map(button => button.textContent);
const sections = () => [...document.querySelectorAll(".menu-section-title")].map(node => node.textContent);
const radio = (aria: string) => document.querySelector<HTMLButtonElement>(`[role=radio][aria-label="${aria}"]`)!;
beforeEach(async () => {
  await resetBoardTestDOM(); setLang("zh"); setRenderer(() => {});
  Object.assign(state, { phase: "live", screen: "pane", paneId: "p1", panePinned: {}, paneTouched: {}, listGroup: "flat",
    fullTerminal: false, agentChat: false, composeLive: false, termWrap: false, termSelect: false,
    paneTermModes: { p1: "guided" }, operationBusy: false, termFit: "fit", termCols: 120, termFontPx: 14,
    operationCapabilities: { ...NO_OPERATION_CAPABILITIES },
    agents: [{ paneId: "p1", paneLabel: "First", agent: "codex", status: "idle", workspaceId: "w1", workspaceLabel: "One", tabId: "t1", cwd: "/one" }],
    live: { isConnected: () => true } });
});
afterEach(async () => await act(async () => { closeTestDialogs(); await new Promise(resolve => setTimeout(resolve, 10)); }));

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
  state.fullTerminal = true; state.paneTermModes = { p1: "full" }; state.termFit = "pan"; state.termCols = 120;
  act(openPaneMenu);
  expect(labels()).toContain(t("pane.reconnect"));
  expect(labels()).not.toContain(t("menu.wrap"));
  expect(radio(t("pane.fitAria")).getAttribute("aria-checked")).toBe("false");
  for (const cols of TERM_COL_PRESETS) expect(radio(t("pane.panColsAria", { cols })).getAttribute("aria-checked")).toBe(String(cols === 120));
});

test("agent chat omits terminal input/display while retaining pane operations", () => {
  state.agentChat = true; state.paneTermModes = { p1: "agent" };
  act(openPaneMenu);
  expect(radio(TERM_MODE_MENU.agent).disabled).toBeFalse();
  expect(sections()).not.toContain(t("menu.input"));
  expect(sections()).not.toContain(t("menu.display"));
  expect(labels()).toContain(t("op.closePane"));
});

test("individual capabilities reveal creation, worktree and split-layout actions", () => {
  state.operationCapabilities = { ...NO_OPERATION_CAPABILITIES, create_tab: true, split_pane: true, list_worktrees: true,
    create_worktree: true, open_worktree: true, zoom_pane: true, resize_pane: true, swap_pane: true };
  state.agents.push({ ...state.agents[0], paneId: "p2" });
  state.termFontPx = TERM_FONT_MAX;
  act(openPaneMenu);
  for (const label of [t("menu.newTab"), t("menu.split"), t("menu.worktrees"), t("menu.newWorktree"), t("menu.openWorktree"), t("menu.zoom"), t("menu.swap")]) expect(labels()).toContain(label);
  const grow = [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find(button => button.textContent === t("pane.fontUpCurrent", { n: TERM_FONT_MAX }))!;
  expect(grow.disabled).toBeTrue();
});

test("switcher keeps ranked cards, pinned marker, active state and contextual metadata", () => {
  state.agents.push({ ...state.agents[0], paneId: "p2", paneLabel: "Pinned", status: "working" });
  state.panePinned = { p2: 1 };
  act(openPaneSwitcher);
  const items = [...document.querySelectorAll(".switch-item")];
  expect(items).toHaveLength(2);
  expect(items[0].querySelector(".switch-name")?.textContent).toBe("Pinned");
  expect(items[0].querySelector(".pin-mark")?.getAttribute("aria-hidden")).toBe("true");
  expect(items[1].classList.contains("on")).toBeTrue();
  expect(items[0].querySelector(".switch-meta")?.textContent).toContain(t("status.working"));
});

test("empty switcher retains its explanation and cancel action", () => {
  state.agents = [];
  act(openPaneSwitcher);
  expect(document.querySelector(".switch-list")?.textContent).toContain(t("home.switcherEmptyTitle"));
  expect(labels()).toContain(t("cancel"));
});
