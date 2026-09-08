import { resetTestDOM } from "../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { setLang, t } from "../../lib/i18n";
import { app, clearNotice, showStatus, state } from "../../state";
import { notifySessionUI } from "../session/ui-revision";
import type { PaneModel } from "../session/model";
import { leaveReactScreen, renderReactScreen } from "./root";
import { SessionPane } from "./session-pane";

let connected = true;
let back = 0, menu = 0, inspect = 0, switched = 0;
const handlers = {
  onBack: () => { back++; }, onMenu: () => { menu++; },
  onWorkspace: () => { inspect++; }, onSwitch: () => { switched++; },
};
const parts = {
  Terminal: ({ model }: { model: PaneModel }) => <div data-testid="buffer">{model.texts.join("\n")}</div>,
  RowBar: ({ model }: { model: PaneModel }) => <div data-testid="rowbar">{model.texts[0]}</div>,
  Dock: () => <div className="dock"><textarea aria-label="Test draft" defaultValue="draft" /></div>,
};

function paint(includeBack = true) {
  act(() => renderReactScreen(<SessionPane key={state.paneId} includeBack={includeBack} handlers={handlers}
    scroll={{ top: 0, left: 0, bottom: true }} parts={parts} />));
}

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
  connected = true;
  back = menu = inspect = switched = 0;
  Object.assign(state, { phase: "live", screen: "pane", paneId: "p1", paneText: "first output", paneHash: "hash",
    termSelect: false, operationBusy: false, composeFocused: false, agentChat: false, fullTerminal: false,
    networkOnline: true, runtimeKind: "herdr",
    agents: [{ paneId: "p1", agent: "codex", hasAgent: true, status: "working", cwd: "/repo/project", tabId: "t1", workspaceId: "w1" }],
    live: { isConnected: () => connected } });
  clearNotice();
});

afterEach(() => {
  act(() => { leaveReactScreen(); clearNotice(); });
  state.screen = "home";
  state.live = null;
});

test("status publication keeps header identity while updating visible status, accessibility and Stop together", () => {
  paint();
  const title = app.querySelector<HTMLButtonElement>(".chrome-title")!;
  expect(app.querySelector(".icon-stop") !== null).toBeTrue();
  expect(title.getAttribute("aria-label")).toContain(t("status.working"));
  state.agents = state.agents.map(agent => ({ ...agent, status: "idle" }));
  act(notifySessionUI);
  expect(app.querySelector(".chrome-title") === title).toBeTrue();
  expect(app.querySelector(".icon-stop")).toBeNull();
  expect(title.getAttribute("aria-label")).toContain(t("status.idle"));
  connected = false;
  act(notifySessionUI);
  expect(title.querySelector(".agent-unknown") !== null).toBeTrue();
  expect(title.getAttribute("aria-label")).toContain(t("status.unverifiable"));
});

test("snapshot updates preserve the focused draft and selection while selection mode pins terminal and row data", () => {
  paint();
  const field = app.querySelector<HTMLTextAreaElement>("textarea")!;
  field.value = "draft under edit";
  field.focus();
  field.setSelectionRange(2, 7);
  state.paneText = "next output";
  act(notifySessionUI);
  expect(app.querySelector("textarea") === field).toBeTrue();
  expect(document.activeElement === field).toBeTrue();
  expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(["draft under edit", 2, 7]);
  expect(app.querySelector('[data-testid="buffer"]')?.textContent).toBe("next output");
  state.termSelect = true;
  paint();
  state.paneText = "later output";
  act(notifySessionUI);
  expect(app.querySelector('[data-testid="buffer"]')?.textContent).toBe("next output");
  expect(app.querySelector('[data-testid="rowbar"]')?.textContent).toBe("next output");
  expect(app.querySelector(".select-bar") !== null).toBeTrue();
  expect(app.querySelector(".dock")).toBeNull();
  state.termSelect = false;
  paint();
  expect(app.querySelector('[data-testid="buffer"]')?.textContent).toBe("later output");
});

test("header actions and busy gating remain available in the expected order", () => {
  paint();
  act(() => {
    app.querySelector<HTMLButtonElement>(".back")!.click();
    app.querySelector<HTMLButtonElement>(".chrome-title")!.click();
    app.querySelector<HTMLButtonElement>(".icon-workspace")!.click();
    app.querySelector<HTMLButtonElement>(".icon-more")!.click();
  });
  expect([back, switched, inspect, menu]).toEqual([1, 1, 1, 1]);
  expect([...app.querySelectorAll(".chrome-actions button")].map(button => button.className))
    .toEqual(["icon-btn icon-stop", "icon-btn icon-workspace", "icon-btn icon-more"]);
  state.operationBusy = true;
  act(notifySessionUI);
  expect(app.querySelector<HTMLButtonElement>(".icon-more")!.disabled).toBeTrue();
  paint(false);
  expect(app.querySelector(".back")).toBeNull();
});

test("notices update between chrome and buffer without resetting the pane", () => {
  paint();
  const pane = app.querySelector(".pane-root");
  act(() => showStatus("session notice", true));
  expect(app.querySelector(".pane-root") === pane).toBeTrue();
  const notice = app.querySelector("[data-react-notice]")!;
  expect(notice.previousElementSibling?.className).toBe("chrome");
  expect(notice.nextElementSibling?.getAttribute("data-testid")).toBe("buffer");
  act(clearNotice);
  expect(app.querySelector("[data-react-notice]")).toBeNull();
});
