import { expectSameNode } from "../../../../test-support/node-identity";
import { resetTestDOM } from "../../../../test-support/boot-dom";
import { happy } from "../../../../test-support/dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { appRoot } from "../../../app/dom-root";
import { bindSessionOwnerFromLive } from "../bind-live";
import { setLang, t } from "../../../lib/i18n";
import { clearNotice, showError, showStatus } from "../../../app/notices-store";
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
let back = 0, menu = 0, inspect = 0;
const handlers = {
  onBack: () => { back++; }, onMenu: () => { menu++; },
  onWorkspace: () => { inspect++; },
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
  back = menu = inspect = 0;
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

test("losing contact updates the header by itself, with no session repaint", () => {
  paint();
  const title = appRoot().querySelector<HTMLElement>(".chrome-title")!;
  expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.working"));
  // A typed connection action only: nothing asks the session view to repaint.
  act(() => setNetworkOnline(false));
  expect(title.querySelector(".agent-avatar-status.is-unknown") !== null).toBeTrue();
  expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.unverifiable"));
  act(() => setNetworkOnline(true));
  expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.working"));
  // Stopping is the send button's job; the header never shows a stop target.
  expect(appRoot().querySelector(".icon-stop")).toBeNull();
});

test("beside the list a status lost with the connection says so: the row's word, then the reason", () => {
  happy.happyDOM.setWindowSize({ width: 1440, height: 900 });
  try {
    paint();
    const title = appRoot().querySelector<HTMLElement>(".chrome-title")!;
    const facts = title.querySelector(".chrome-meta-text")!.textContent!;
    expect(facts).not.toContain(t("deskChrome.notConnected"));
    act(() => setNetworkOnline(false));
    // The same word the list row shows for this session, and why.
    expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.unverifiable"));
    expect(title.querySelector(".chrome-meta-text")?.textContent).toBe(`${t("deskChrome.notConnected")} · ${facts}`);
    expect(title.getAttribute("title")).toContain(`${t("status.unverifiable")} · ${t("deskChrome.notConnected")}`);
    act(() => setNetworkOnline(true));
    expect(title.querySelector(".chrome-meta-text")?.textContent).toBe(facts);
  } finally {
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  }
});

test("the phone header keeps its line when contact is lost", () => {
  paint();
  const title = appRoot().querySelector<HTMLElement>(".chrome-title")!;
  const facts = title.querySelector(".chrome-meta-text")!.textContent!;
  act(() => setNetworkOnline(false));
  expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.unverifiable"));
  expect(title.querySelector(".chrome-meta-text")?.textContent).toBe(facts);
});

test("status publication keeps header identity while updating the visible status and its full text together", () => {
  paint();
  const title = appRoot().querySelector<HTMLElement>(".chrome-title")!;
  expect(title.getAttribute("title")).toContain(t("status.working"));
  act(() => { applySnapshot(SNAPSHOT("idle")); notifySessionUI(); });
  expectSameNode(appRoot().querySelector(".chrome-title"), title);
  expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.waitingInput"));
  expect(title.getAttribute("title")).toContain(t("status.waitingInput"));
  connected = false;
  act(notifySessionUI);
  expect(title.querySelector(".agent-avatar-status.is-unknown") !== null).toBeTrue();
  expect(title.getAttribute("title")).toContain(t("status.unverifiable"));
});

test("snapshot updates preserve the focused draft and selection while selection mode pins terminal and row data", () => {
  paint();
  const field = appRoot().querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => { field.value = "draft under edit"; field.focus(); });
  field.setSelectionRange(2, 7);
  act(() => { applyPaneRead("next output", "hash"); });
  act(notifySessionUI);
  expectSameNode(appRoot().querySelector("textarea"), field);
  expectSameNode(document.activeElement, field);
  expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(["draft under edit", 2, 7]);
  expect(appRoot().querySelector('[data-testid="buffer"]')?.textContent).toBe("next output");
  act(() => { setTermSelect(true); });
  paint();
  act(() => { applyPaneRead("later output", "hash"); });
  act(notifySessionUI);
  expect(appRoot().querySelector('[data-testid="buffer"]')?.textContent).toBe("next output");
  expect(appRoot().querySelector('[data-testid="rowbar"]')?.textContent).toBe("next output");
  // Selection floats its hint over the buffer; the dock keeps its place (inert)
  // so the rows do not move under the finger that started the selection.
  expect(appRoot().querySelector(".term-stage > .select-hint") !== null).toBeTrue();
  expect(appRoot().querySelector(".dock-slot > .dock") !== null).toBeTrue();
  expect(appRoot().querySelector(".dock-slot")?.hasAttribute("inert")).toBeTrue();
  act(() => { setTermSelect(false); });
  paint();
  expect(appRoot().querySelector('[data-testid="buffer"]')?.textContent).toBe("later output");
});

test("header actions and busy gating remain available in the expected order", () => {
  paint();
  act(() => {
    appRoot().querySelector<HTMLButtonElement>(".back")!.click();
    appRoot().querySelector<HTMLElement>(".chrome-title")!.click();
    appRoot().querySelector<HTMLButtonElement>(".icon-workspace")!.click();
    appRoot().querySelector<HTMLButtonElement>(".icon-more")!.click();
  });
  // The identity is display-only; the trailing pair never changes with status.
  expect([back, inspect, menu]).toEqual([1, 1, 1]);
  expect([...appRoot().querySelectorAll(".chrome-actions button")].map(button => button.className))
    .toEqual(["icon-btn icon-workspace", "icon-btn icon-more"]);
  act(() => { setOperationBusy(true); notifySessionUI(); });
  expect(appRoot().querySelector<HTMLButtonElement>(".icon-more")!.disabled).toBeTrue();
  paint(false);
  expect(appRoot().querySelector(".back")).toBeNull();
});

test("a passing notice floats between chrome and buffer without resetting the pane or the buffer", () => {
  paint();
  const pane = appRoot().querySelector(".pane-root");
  const stage = appRoot().querySelector(".term-stage");
  const buffer = appRoot().querySelector("[data-testid=buffer]");
  act(() => showStatus("session notice"));
  expectSameNode(appRoot().querySelector(".pane-root"), pane);
  const notice = appRoot().querySelector("[data-react-notice]")!;
  // It hangs from an anchor of no height (session-shell.scss), so the buffer under it is not laid out again.
  const anchor = notice.parentElement!;
  expect(anchor.className).toBe("session-notice");
  expect(anchor.previousElementSibling?.className).toBe("chrome");
  expectSameNode(anchor.nextElementSibling, stage);
  expectSameNode(stage?.firstElementChild, buffer);
  act(clearNotice);
  expect(appRoot().querySelector("[data-react-notice]")).toBeNull();
  expect(appRoot().querySelector(".session-notice")).toBeNull();
  expectSameNode(appRoot().querySelector(".term-stage"), stage);
  expectSameNode(appRoot().querySelector("[data-testid=buffer]"), buffer);
});

test("an error that stays until the reader acts keeps its place in the page, between chrome and buffer", () => {
  paint();
  const stage = appRoot().querySelector(".term-stage");
  act(() => showError("send not confirmed", true));
  const notice = appRoot().querySelector("[data-react-notice]")!;
  expectSameNode(notice.parentElement, appRoot().querySelector(".pane-root"));
  expect(notice.previousElementSibling?.className).toBe("chrome");
  expectSameNode(notice.nextElementSibling, stage);
  expect(appRoot().querySelector(".session-notice")).toBeNull();
});