import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { happy, resetBoardTestDOM } from "../../test-support/dom";
import { setPhase } from "../features/connection/connection-store";
import { applySnapshot } from "../features/dashboard/catalog-store";
import { openPaneId, resetPaneView, selectPane, setFullTerminal } from "../features/session/session-store";
import { batch } from "../shared/model/domain-store";
import { openDesktop, leaveDesktop, toggleDesktopLayoutRail } from "./desktop-nav";
import { publishAllDomains } from "./domain-publication";
import { currentLayout } from "./layout-input";
import { currentScreen, desktopRailCollapsed, setScreen } from "./navigation-store";

describe("desktop navigation", () => {
  beforeEach(async () => {
    await resetBoardTestDOM();
    happy.happyDOM.setWindowSize({ width: 1280, height: 800 });
    batch(() => {
      setPhase("live");
      setScreen("pane");
      selectPane("p1");
      setFullTerminal(true);
      applySnapshot({
        workspaces: [{ workspace_id: "w1", label: "demo" }],
        panes: [{ pane_id: "p1", workspace_id: "w1", agent: "codex", agent_status: "idle", has_agent: true }],
      });
    });
    publishAllDomains();
  });

  afterEach(() => {
    resetPaneView();
    setScreen("home");
    publishAllDomains();
    happy.happyDOM.setWindowSize({ width: 390, height: 844 });
  });

  test("entering and leaving desktop preserves open paneId and fullTerminal without PTY resize", () => {
    expect(openPaneId()).toBe("p1");
    expect(currentScreen()).toBe("pane");

    act(() => openDesktop());
    expect(currentScreen()).toBe("desktop");
    expect(openPaneId()).toBe("p1");
    expect(currentLayout().deskPage).toBe("desktop");
    expect(currentLayout().deskChild).toBeNull();
    expect(desktopRailCollapsed()).toBeFalse();

    act(() => toggleDesktopLayoutRail());
    expect(desktopRailCollapsed()).toBeTrue();
    expect(currentLayout().shell.railHidden).toBeTrue();

    act(() => leaveDesktop());
    expect(currentScreen()).toBe("pane");
    expect(openPaneId()).toBe("p1");
    expect(currentLayout().deskChild).toBe("full");
  });

  test("entering desktop from settings returns to settings on leave", () => {
    setScreen("settings");
    publishAllDomains();

    act(() => openDesktop());
    expect(currentScreen()).toBe("desktop");

    act(() => leaveDesktop());
    expect(currentScreen()).toBe("settings");
  });
});
