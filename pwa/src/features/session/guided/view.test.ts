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
import { applySnapshot } from "../../dashboard/catalog-store";
import { patchChromeTitle, type SessionHandlers } from "./view";
import { SessionPane } from "./session-pane";
import type { LiveSession } from "../../../lib/protocol/client";

const viewSource = await Bun.file(new URL("./view.ts", import.meta.url)).text();
const chromeSource = await Bun.file(new URL("./session-chrome.tsx", import.meta.url)).text();
const paneSource = await Bun.file(new URL("./session-pane.tsx", import.meta.url)).text();

let connected = true;
let back = 0, menu = 0, inspect = 0, switched = 0;
const handlers: SessionHandlers = {
  onBack: () => { back++; },
  onMenu: () => { menu++; },
  onSwitch: () => { switched++; },
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
  back = menu = inspect = switched = 0;
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
   * full render, on a phone viewport. Status, the accessible name, and the
   * interrupt button must stay on the same published snapshot.
   */
  test("the patch path goes through the same status sync as the builder", () => {
    paint();
    const title = appRoot().querySelector<HTMLButtonElement>(".chrome-title")!;
    expect(appRoot().querySelector(".icon-stop") !== null).toBeTrue();
    expect(title.getAttribute("aria-label")).toContain(t("status.working"));
    act(() => {
      applySnapshot({
        ...AGENT_SNAPSHOT,
        panes: [{ ...AGENT_SNAPSHOT.panes[0]!, agent_status: "idle" }],
      });
      patchChromeTitle();
    });
    expect(appRoot().querySelector(".chrome-title") === title).toBeTrue();
    expect(appRoot().querySelector(".icon-stop")).toBeNull();
    expect(title.getAttribute("aria-label")).toContain(t("status.idle"));
    expect(viewSource).toContain("flushSync(notifySessionUI)");
    expect(viewSource).toContain("export function patchChromeTitle");
  });

  test("status sync owns the accessible name and the interrupt button", () => {
    paint();
    const title = appRoot().querySelector<HTMLButtonElement>(".chrome-title")!;
    expect(title.getAttribute("aria-label")).toContain(t("status.working"));
    expect(appRoot().querySelector(".icon-stop")?.getAttribute("aria-label")).toBe(t("pane.interrupt"));
    expect(chromeSource).toContain("icon-stop");
    expect(chromeSource).toContain('t("pane.interrupt")');
    expect(chromeSource).toContain('t("pane.menuTitle")');
    expect(chromeSource).not.toContain("title.after");
    expect(viewSource).not.toContain("syncChromeStop");
  });

  test("nothing else builds the interrupt button behind the sync's back", () => {
    expect(viewSource).not.toContain("icon-stop");
    paint();
    expect(appRoot().querySelectorAll(".icon-stop")).toHaveLength(1);
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
      .toEqual(["icon-btn icon-stop", "icon-btn icon-workspace", "icon-btn icon-more"]);
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
    expect(notice.nextElementSibling?.classList.contains("term-wrap")).toBeTrue();
    expect(paneSource).toContain("<AppNotice />");
    expect(viewSource).not.toContain("appendNotice");
    expect(viewSource).not.toContain("selectBar");
    expect(viewSource).not.toContain("noteNode");
  });

  test("the status dot sits with the status line so the title can use the full width", () => {
    paint();
    const title = appRoot().querySelector(".chrome-title")!;
    const name = title.querySelector(".chrome-name");
    const meta = title.querySelector(".chrome-meta");
    const dot = title.querySelector(".agent-dot");
    expect(name !== null).toBeTrue();
    expect(meta !== null).toBeTrue();
    expect(dot !== null).toBeTrue();
    expect(name!.nextElementSibling === meta).toBeTrue();
    expect(meta!.querySelector(".agent-dot") === dot).toBeTrue();
    expect(meta!.querySelector(".chrome-meta-text") !== null).toBeTrue();
    expect(title.querySelector(".chrome-name-row")).toBeNull();
    expect(chromeSource).toContain("chrome-name");
    expect(chromeSource).toContain("chrome-meta-text");
    expect(chromeSource).toContain("agent-dot");
    expect(chromeSource).not.toContain("chrome-name-row");
  });

  test("the visible subtitle is a short status line, not the dashboard card meta", () => {
    paint();
    const visible = appRoot().querySelector(".chrome-meta-text")?.textContent ?? "";
    expect(visible).toContain("project");
    expect(visible).toBe(`${t("status.working")} · project`);
    const title = appRoot().querySelector<HTMLButtonElement>(".chrome-title")!;
    expect(title.title).toBe(`demo · ${t("status.working")} · codex · project`);
    expect(title.getAttribute("aria-label")).toBe(t("chrome.switchAriaMeta", {
      title: "demo", line: `${t("status.working")} · codex · project`,
    }));
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
    expect(appRoot().querySelector(".chrome-meta-text")?.textContent)
      .toBe(`${t("status.working")} · project · ${t("chrome.split")}`);
    expect(chromeSource).toContain("cwdName(selected.cwd)");
    expect(chromeSource).toContain('tabIsSplit(selected, [...agents]) ? t("chrome.split")');
    expect(chromeSource).toContain("agentMeta(selected)");
    expect(chromeSource).toContain("chromeName(selected)");
    expect(chromeSource.indexOf("agentMeta(selected)")).toBeGreaterThan(-1);
    expect(chromeSource.indexOf("cwdName(selected.cwd)")).toBeGreaterThan(-1);
  });
});