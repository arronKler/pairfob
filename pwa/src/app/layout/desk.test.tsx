import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetBoardTestDOM } from "../../../test-support/dom";
import { batch } from "../../shared/model/domain-store";
import { setLang, t } from "../../lib/i18n";
import { setNetworkOnline, setPhase } from "../../features/connection/connection-store";
import { applyRuntimeIdentity } from "../../features/connection/runtime-store";
import { attachLiveSession } from "../../features/computers/catalog-store";
import { replaceAgentsFromSnapshot, resetDashboard } from "../../features/dashboard/catalog-store";
import { resetBoardCatalog } from "../../features/board/layout-store";
import { setScreen } from "../navigation-store";
import { publishAllDomains } from "../domain-publication";
import type { LiveSession } from "../../lib/protocol/client";
import { DeskShell } from "./desk";

/**
 * The desk shell's main column: the board sits beside the rail like any other
 * desk page, and a pane opened from it carries one way back.
 */
let root: Root | null = null;
let container: HTMLElement;

beforeEach(async () => {
  await resetBoardTestDOM();
  setLang("zh");
  batch(() => {
    setPhase("live");
    setScreen("board");
    setNetworkOnline(true);
    applyRuntimeIdentity({ herdHost: "", runtimeKind: "herdr" });
    attachLiveSession({ isConnected: () => true } as LiveSession);
    resetDashboard();
    resetBoardCatalog();
    replaceAgentsFromSnapshot({
      workspaces: [{ workspace_id: "w1", label: "One", cwd: "/one" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }, { tab_id: "w1:t2", workspace_id: "w1", label: "other" }],
      panes: [
        { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "codex", agent_status: "working" },
        { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent: "codex", agent_status: "idle" },
      ],
    } as never);
  });
  publishAllDomains();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("desk shell", () => {
  test("the wide board fills the main column and keeps the rail beside it", () => {
    act(() => root!.render(<DeskShell deskPage="board" />));
    expect(container.querySelector(".rail")).not.toBeNull();
    const main = container.querySelector(".main.main-board");
    expect(main?.querySelector(".board-shell")).not.toBeNull();
    expect(container.querySelector(".main-empty")).toBeNull();
    const current = container.querySelector(".rail-nav .is-current");
    expect(current?.textContent).toBe(t("home.board"));
    expect(current?.getAttribute("aria-current")).toBe("page");
  });

  test("a pane opened from the board leads back to it; any other pane does not", () => {
    let returned = 0;
    act(() => root!.render(<DeskShell deskPage={null} onReturn={() => { returned += 1; }}><div className="pane-root" /></DeskShell>));
    const back = container.querySelector<HTMLButtonElement>(".main .desk-return");
    expect(back?.textContent).toBe(t("desk.backToBoard"));
    expect(back?.nextElementSibling?.className).toBe("pane-root");
    act(() => back!.click());
    expect(returned).toBe(1);

    act(() => root!.render(<DeskShell deskPage={null}><div className="pane-root" /></DeskShell>));
    expect(container.querySelector(".desk-return")).toBeNull();
    // With nothing to show, the pick prompt never grows a way back.
    act(() => root!.render(<DeskShell deskPage={null} onReturn={() => undefined} />));
    expect(container.querySelector(".desk-return")).toBeNull();
    expect(container.querySelector(".main-empty")).not.toBeNull();
  });

  test("off the board the rail's Board link is not current", () => {
    act(() => setScreen("home"));
    publishAllDomains();
    act(() => root!.render(<DeskShell deskPage={null} />));
    expect(container.querySelector(".rail-nav .is-current")).toBeNull();
  });
});
