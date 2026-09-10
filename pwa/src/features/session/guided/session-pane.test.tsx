import { resetTestDOM } from "../../../../test-support/boot-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../../app/dom-root";
import { bindSessionOwnerFromLive } from "../bind-live";
import { setLang, t } from "../../../lib/i18n";
import { clearNotice, showStatus } from "../../../app/notices-store";
import { setPhase, setNetworkOnline } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { applyRuntimeIdentity, runtimeIdentity } from "../../connection/runtime-store";
import { applyPaneRead, openPaneId, selectPane, setAgentChat, setFullTerminal, setTermSelect } from "../session-store";
import { setComposeFocused } from "../compose-store";
import { setOperationBusy } from "../../operations/capabilities-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { applySnapshot } from "../../dashboard/catalog-store";
import { notifySessionUI } from "./ui-revision";
import type { PaneModel } from "./pane-model";
import { SessionPane } from "./session-pane";
import type { LiveSession } from "../../../lib/protocol/client";

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

const SNAPSHOT = (status: string) => ({
  workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/repo/project" }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
  panes: [{
    pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo/project",
    agent: "codex", agent_status: status,
  }],
});

function paint(includeBack = true) {
  bindSessionOwnerFromLive();
  renderReact(<SessionPane key={openPaneId()} includeBack={includeBack} handlers={handlers}
    scroll={{ top: 0, left: 0, bottom: true }} parts={parts} />);
}

// applySnapshot seeds the dashboard and prunes daemon-scoped panes; capture the
// pre-seed canonical/raw/projection so afterEach restores exactly (no broad
// resetDashboard).
const snapshotRestorer = new WorkspaceSnapshotRestorer();

beforeEach(async () => {
  await resetTestDOM();
  setLang("zh");
  connected = true;
  back = menu = inspect = switched = 0;
  snapshotRestorer.capture();
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("first output", "hash");
    setTermSelect(false);
    setOperationBusy(false);
    setComposeFocused(false);
    setAgentChat(false);
    setFullTerminal(false);
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: runtimeIdentity().herdHost, runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => connected } as unknown as LiveSession);
    applySnapshot(SNAPSHOT("working"));
  });
  clearNotice();
});

afterEach(() => {
  act(() => { unmountReact(); clearNotice(); });
  setScreen("home");
  attachLiveSession(null);
  snapshotRestorer.restore();
});

test("status publication keeps header identity while updating visible status, accessibility and Stop together", () => {
  paint();
  const title = appRoot().querySelector<HTMLButtonElement>(".chrome-title")!;
  expect(appRoot().querySelector(".icon-stop") !== null).toBeTrue();
  expect(title.getAttribute("aria-label")).toContain(t("status.working"));
  act(() => { applySnapshot(SNAPSHOT("idle")); notifySessionUI(); });
  expect(appRoot().querySelector(".chrome-title") === title).toBeTrue();
  expect(appRoot().querySelector(".icon-stop")).toBeNull();
  expect(title.getAttribute("aria-label")).toContain(t("status.idle"));
  connected = false;
  act(notifySessionUI);
  expect(title.querySelector(".agent-unknown") !== null).toBeTrue();
  expect(title.getAttribute("aria-label")).toContain(t("status.unverifiable"));
});

test("snapshot updates preserve the focused draft and selection while selection mode pins terminal and row data", () => {
  paint();
  const field = appRoot().querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => { field.value = "draft under edit"; field.focus(); });
  field.setSelectionRange(2, 7);
  act(() => { applyPaneRead("next output", "hash"); });
  act(notifySessionUI);
  expect(appRoot().querySelector("textarea") === field).toBeTrue();
  expect(document.activeElement === field).toBeTrue();
  expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(["draft under edit", 2, 7]);
  expect(appRoot().querySelector('[data-testid="buffer"]')?.textContent).toBe("next output");
  act(() => { setTermSelect(true); });
  paint();
  act(() => { applyPaneRead("later output", "hash"); });
  act(notifySessionUI);
  expect(appRoot().querySelector('[data-testid="buffer"]')?.textContent).toBe("next output");
  expect(appRoot().querySelector('[data-testid="rowbar"]')?.textContent).toBe("next output");
  expect(appRoot().querySelector(".select-bar") !== null).toBeTrue();
  expect(appRoot().querySelector(".dock")).toBeNull();
  act(() => { setTermSelect(false); });
  paint();
  expect(appRoot().querySelector('[data-testid="buffer"]')?.textContent).toBe("later output");
});

test("header actions and busy gating remain available in the expected order", () => {
  paint();
  act(() => {
    appRoot().querySelector<HTMLButtonElement>(".back")!.click();
    appRoot().querySelector<HTMLButtonElement>(".chrome-title")!.click();
    appRoot().querySelector<HTMLButtonElement>(".icon-workspace")!.click();
    appRoot().querySelector<HTMLButtonElement>(".icon-more")!.click();
  });
  expect([back, switched, inspect, menu]).toEqual([1, 1, 1, 1]);
  expect([...appRoot().querySelectorAll(".chrome-actions button")].map(button => button.className))
    .toEqual(["icon-btn icon-stop", "icon-btn icon-workspace", "icon-btn icon-more"]);
  act(() => { setOperationBusy(true); notifySessionUI(); });
  expect(appRoot().querySelector<HTMLButtonElement>(".icon-more")!.disabled).toBeTrue();
  paint(false);
  expect(appRoot().querySelector(".back")).toBeNull();
});

test("notices update between chrome and buffer without resetting the pane", () => {
  paint();
  const pane = appRoot().querySelector(".pane-root");
  act(() => showStatus("session notice", true));
  expect(appRoot().querySelector(".pane-root") === pane).toBeTrue();
  const notice = appRoot().querySelector("[data-react-notice]")!;
  expect(notice.previousElementSibling?.className).toBe("chrome");
  expect(notice.nextElementSibling?.getAttribute("data-testid")).toBe("buffer");
  act(clearNotice);
  expect(appRoot().querySelector("[data-react-notice]")).toBeNull();
}
);