import { agentStatusLabel } from "../../../lib/dashboard";
import { resetBoardTestDOM } from "../../../../test-support/dom";
import { WorkspaceSnapshotRestorer } from "../../../../test-support/workspace-snapshot-restore";
import { ScalarPreferenceState } from "../../../../test-support/preferences-scalar-restore";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderReact, unmountReact } from "../../../../test-support/react-harness";
import { appRoot } from "../../../app/dom-root";
import { bindSessionOwnerFromLive } from "../bind-live";
import { setLang, t } from "../../../lib/i18n";
import { clearNotice, showStatus } from "../../../app/notices-store";
import { setPhase, setNetworkOnline } from "../../connection/connection-store";
import { setScreen } from "../../../app/navigation-store";
import { applyRuntimeIdentity, runtimeIdentity } from "../../connection/runtime-store";
import { applyPaneRead, selectPane, setAgentChat, setFullTerminal, setPaneFollow, setPaneRow, setPaneUnread, setTermSelect } from "../session-store";
import { setComposeDraft, setComposeFocused, setComposeIME, setComposeLive } from "../compose-store";
import { setDefaultComposeLive, setKeysExpanded, setPadKind, setPaneComposeLive } from "../../settings/preferences-store";
import { setOperationBusy } from "../../operations/capabilities-store";
import { attachLiveSession } from "../../computers/catalog-store";
import { applySnapshot, selectedAgent } from "../../dashboard/catalog-store";
import { paneIdentity } from "../../dashboard/model/herd-view";
import { patchChromeTitle, type SessionHandlers } from "./view";
import { SessionPane } from "./session-pane";
import type { LiveSession } from "../../../lib/protocol/client";

const viewSource = await Bun.file(new URL("./view.ts", import.meta.url)).text();
const chromeSource = await Bun.file(new URL("./session-chrome.tsx", import.meta.url)).text();
const paneSource = await Bun.file(new URL("./session-pane.tsx", import.meta.url)).text();

let connected = true;
let back = 0, menu = 0, inspect = 0;
const handlers: SessionHandlers = {
  onBack: () => { back++; },
  onMenu: () => { menu++; },
  onWorkspace: () => { inspect++; },
};

function paint(includeBack = true): void {
  bindSessionOwnerFromLive();
  renderReact(createElement(SessionPane, {
    includeBack, handlers, scroll: { top: 0, left: 0, bottom: true },
  }));
}

// applying AGENT_SNAPSHOT seeds the dashboard and prunes daemon-scoped panes;
// capture the pre-seed canonical/raw/projection so afterEach can restore it.
const snapshotRestorer = new WorkspaceSnapshotRestorer();
// The scalar preference resets below (setKeysExpanded/setPadKind/
// setDefaultComposeLive) persist via their own saveX -> writeStorage; capture
// canonical+raw pre-images before they run and restore after own teardown.
const scalarPrefState = new ScalarPreferenceState();

/** The one pane the chrome tests assert on; p1 is also the open pane. */
const AGENT_SNAPSHOT = {
  workspaces: [{ workspace_id: "w1", label: "demo", cwd: "/repo/project" }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "main" }],
  panes: [{
    pane_id: "p1", workspace_id: "w1", tab_id: "t1", cwd: "/repo/project",
    agent: "codex", agent_status: "working", label: "demo",
  }],
};

beforeEach(async () => {
  await resetBoardTestDOM();
  unmountReact();
  appRoot().replaceChildren();
  setLang("zh");
  connected = true;
  back = menu = inspect = 0;
  snapshotRestorer.capture();
  scalarPrefState.capture();
  act(() => {
    setPhase("live");
    setScreen("pane");
    selectPane("p1");
    applyPaneRead("first output", "hash");
    setTermSelect(false);
    setOperationBusy(false);
    setComposeFocused(false);
    setComposeDraft(""); setComposeLive(false); setComposeIME(false);
    setKeysExpanded(false); setPadKind("keys");
    setDefaultComposeLive(false);
    setPaneComposeLive("p1", false);
    setPaneFollow(true); setPaneUnread(false); setPaneRow(null);
    setAgentChat(false);
    setFullTerminal(false);
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: runtimeIdentity().herdHost, runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => connected } as unknown as LiveSession);
    applySnapshot(AGENT_SNAPSHOT);
  });
  clearNotice();
});

afterEach(() => {
  act(() => { unmountReact(); clearNotice(); });
  setScreen("home");
  attachLiveSession(null);
  snapshotRestorer.restore();
  setComposeDraft("");
  appRoot().replaceChildren();
  scalarPrefState.restore();
});

describe("pane header keeps status surfaces in step", () => {
  /**
   * A working/idle flip seen while the pane is open runs patchChromeTitle, not a
   * full render, on a phone viewport. The status word, the avatar dot and the
   * full text must stay on the same published snapshot.
   */
  test("the patch path goes through the same status sync as the builder", () => {
    paint();
    const title = appRoot().querySelector<HTMLElement>(".chrome-title")!;
    expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.working"));
    expect(title.querySelector(".agent-avatar-status.is-working") !== null).toBeTrue();
    act(() => {
      applySnapshot({
        ...AGENT_SNAPSHOT,
        panes: [{ ...AGENT_SNAPSHOT.panes[0]!, agent_status: "idle" }],
      });
      patchChromeTitle();
    });
    expect(appRoot().querySelector(".chrome-title") === title).toBeTrue();
    const idle = agentStatusLabel({ paneId: "p1", agent: "codex", status: "idle", cwd: "", workspaceId: "" });
    expect(title.querySelector(".chrome-status")?.textContent).toBe(idle);
    expect(title.getAttribute("title")).toContain(idle);
    expect(title.querySelector(".agent-avatar-status.is-idle") !== null).toBeTrue();
    expect(viewSource).toContain("flushSync(notifySessionUI)");
    expect(viewSource).toContain("export function patchChromeTitle");
  });

  test("the identity is display-only and the header never offers a stop target", () => {
    paint();
    const title = appRoot().querySelector<HTMLElement>(".chrome-title")!;
    // Not a button: switching sessions goes back through the list.
    expect(title.tagName).toBe("DIV");
    expect(title.closest("button")).toBeNull();
    // Working, yet no header stop: stopping lives on the send button.
    expect(title.querySelector(".chrome-status")?.textContent).toBe(t("status.working"));
    expect(appRoot().querySelector(".icon-stop")).toBeNull();
    expect(chromeSource).not.toContain("icon-stop");
    expect(chromeSource).not.toContain("onSwitch");
    expect(chromeSource).toContain('t("pane.menuTitle")');
    expect(viewSource).not.toContain("onSwitch");
  });

  test("the back button counts the other panes waiting on the reader, never while status is unverifiable", () => {
    act(() => applySnapshot({
      ...AGENT_SNAPSHOT,
      panes: [
        { ...AGENT_SNAPSHOT.panes[0]!, agent_status: "blocked" },
        { ...AGENT_SNAPSHOT.panes[0]!, pane_id: "p2", agent_status: "blocked" },
        { ...AGENT_SNAPSHOT.panes[0]!, pane_id: "p3", agent_status: "blocked", agent: "" },
      ],
    }));
    paint();
    // p1 is this pane; p3 is a plain terminal, which never waits on anyone.
    expect(appRoot().querySelector(".chrome-back-badge")?.textContent).toBe("1");
    expect(appRoot().querySelector(".back")?.getAttribute("aria-label")).toBe(t("chrome.backWaiting", { n: "1" }));
    act(() => setNetworkOnline(false));
    expect(appRoot().querySelector(".chrome-back-badge")).toBeNull();
    expect(appRoot().querySelector(".back")?.getAttribute("aria-label")).toBe(t("chrome.backList"));
  });

  test("pane modes live in the more menu, not as extra chrome slots", () => {
    paint();
    const chrome = appRoot().querySelector(".chrome")!;
    expect(chrome.querySelector(".mode-switch")).toBeNull();
    expect(chrome.textContent).not.toContain("完整终端");
    expect(chrome.textContent).not.toContain("进入对话");
    expect(chrome.textContent).not.toContain("更多操作");
    expect(viewSource).not.toContain("mode-switch");
    expect(viewSource).not.toContain("完整终端");
    expect(viewSource).not.toContain("进入对话");
    expect(viewSource).not.toContain("更多操作");
    expect(viewSource).not.toContain("full-terminal-retry");
    expect(viewSource).not.toContain("退出完整终端");
    expect(chromeSource).toContain("handlers.onWorkspace");
    expect(chromeSource).toContain("handlers.onMenu");
  });

  test("workspace inspection is a first-class trailing action before more", () => {
    paint();
    expect([...appRoot().querySelectorAll(".chrome-actions button")].map((button) => button.className))
      .toEqual(["icon-btn icon-workspace", "icon-btn icon-more"]);
    expect(appRoot().querySelector(".icon-workspace")?.getAttribute("aria-label")).toBe(t("workspace.open"));
    expect(chromeSource).not.toContain("labEnabled");
    const workspace = chromeSource.indexOf("icon-workspace");
    const menu = chromeSource.indexOf("icon-more");
    expect(workspace).toBeGreaterThan(-1);
    expect(menu).toBeGreaterThan(workspace);
  });

  test("in-place pane reads keep the terminal Enter control in sync", () => {
    expect(viewSource).toContain("syncSendButton()");
    expect(viewSource).not.toContain("promptPanel");
  });

  test("app notices sit under the chrome, not in the dock or select bar", () => {
    paint();
    const pane = appRoot().querySelector(".pane-root");
    act(() => showStatus("session notice", true));
    expect(appRoot().querySelector(".pane-root") === pane).toBeTrue();
    const notice = appRoot().querySelector("[data-react-notice]")!;
    expect(notice.previousElementSibling?.className).toBe("chrome");
    expect(notice.nextElementSibling?.classList.contains("term-stage")).toBeTrue();
    expect(notice.nextElementSibling?.firstElementChild?.classList.contains("term-wrap")).toBeTrue();
    expect(paneSource).toContain("<AppNotice />");
    expect(viewSource).not.toContain("appendNotice");
    expect(viewSource).not.toContain("selectBar");
    expect(viewSource).not.toContain("noteNode");
  });

  test("the status dot sits on the avatar, as on the list card, so the title can use the full width", () => {
    paint();
    const title = appRoot().querySelector(".chrome-title")!;
    const name = title.querySelector(".chrome-name");
    const meta = title.querySelector(".chrome-meta");
    expect(name !== null).toBeTrue();
    expect(meta !== null).toBeTrue();
    expect(name!.nextElementSibling === meta).toBeTrue();
    expect(title.querySelector(".chrome-avatar .agent-avatar .agent-avatar-status") !== null).toBeTrue();
    expect(meta!.querySelector(".chrome-status") !== null).toBeTrue();
    expect(meta!.querySelector(".chrome-meta-text") !== null).toBeTrue();
    expect(title.querySelector(".agent-dot")).toBeNull();
  });

  test("the header shows the list card's own title and line, with no header-only facts", () => {
    paint();
    const card = paneIdentity(selectedAgent()!, "flat", false);
    expect(appRoot().querySelector(".chrome-name")?.textContent).toBe(card.title);
    expect(appRoot().querySelector(".chrome-status")?.textContent).toBe(card.statusLabel);
    // The workspace "demo" is already the title here, so it is not repeated.
    expect(appRoot().querySelector(".chrome-meta-text")?.textContent).toBe(card.line);
    expect(appRoot().querySelector<HTMLElement>(".chrome-title")!.title)
      .toBe(`${card.title} · ${card.statusLabel} · ${card.line}`);
    act(() => {
      applySnapshot({
        ...AGENT_SNAPSHOT,
        panes: [
          AGENT_SNAPSHOT.panes[0]!,
          { ...AGENT_SNAPSHOT.panes[0]!, pane_id: "p2" },
        ],
      });
      patchChromeTitle();
    });
    // "Split" is layout, not identity: it lives in the ⋯ menu.
    expect(appRoot().querySelector(".chrome-meta")?.textContent).not.toContain(t("chrome.split"));
    expect(chromeSource).toContain("paneIdentity(");
  });
});